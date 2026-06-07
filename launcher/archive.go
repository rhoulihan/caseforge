// Archive persistence for business cases. The launcher is a dumb blob store: it saves/serves/lists/
// deletes one .zip per case under a local archives directory and only peeks at each zip's manifest.json
// to build the home-screen list. All zip building/parsing lives in the SPA (TypeScript); Go never
// interprets the case contents. Localhost-only (inherits the serve bind), caseId validated against
// traversal, body-size capped, atomic writes. Stdlib only.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const maxManifestBytes = 1 << 20 // manifest.json is tiny; cap the read defensively

const maxArchiveBody = 200 << 20 // 200 MiB — archives carry source docs + images, not just text

// A caseId is a slug: lowercase alnum + hyphen, 1–64 chars, must start alnum. This is the ONLY thing
// that ever reaches the filesystem as a name, so it must not contain '.', '/', '\' or '..'.
var caseIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func validCaseID(id string) bool { return caseIDRe.MatchString(id) }

// manifestMeta is the subset of manifest.json the launcher reads to build the list. Unknown fields ignored.
type manifestMeta struct {
	CaseID         string `json:"caseId"`
	CompanyName    string `json:"companyName"`
	Provider       string `json:"provider"`
	Status         string `json:"status"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
	CurrentVersion string `json:"currentVersion"`
}

func archivePath(dir, id string) string { return filepath.Join(dir, id+".zip") }

// safeArchiveFile resolves <dir>/<id>.zip and refuses anything that escapes `dir` via a symlink — the
// same boundary discipline staticHandler uses. Returns the concrete (symlink-resolved) path to open or
// remove, or ok=false (caller 404s) when the dir/file is missing or the resolved target is out of bounds.
// This stops a planted symlink (e.g. landing in a cloud-synced ~/CaseForge) from turning the localhost
// blob store into an arbitrary-file read/delete.
func safeArchiveFile(dir, id string) (string, bool) {
	root, err := filepath.Abs(dir)
	if err != nil {
		return "", false
	}
	root, err = filepath.EvalSymlinks(root) // dir missing → not found
	if err != nil {
		return "", false
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, id+".zip"))
	if err != nil {
		return "", false // missing / broken symlink
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false // resolved target escapes the archives dir
	}
	return real, true
}

// manifestFromZip finds manifest.json in a zip and parses its metadata. Any failure (no manifest,
// bad/oversized JSON) returns ok=false so callers skip the archive rather than fail.
func manifestFromZip(zr *zip.Reader) (manifestMeta, bool) {
	for _, f := range zr.File {
		if f.Name != "manifest.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return manifestMeta{}, false
		}
		defer rc.Close()
		var m manifestMeta
		if err := json.NewDecoder(io.LimitReader(rc, maxManifestBytes)).Decode(&m); err != nil {
			return manifestMeta{}, false
		}
		return m, true
	}
	return manifestMeta{}, false
}

// readManifest opens a case zip on disk and returns its manifest.json metadata (false on any failure).
func readManifest(zipPath string) (manifestMeta, bool) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return manifestMeta{}, false
	}
	defer r.Close()
	return manifestFromZip(&r.Reader)
}

// zipHasManifest reports whether `data` is a readable zip containing a parseable manifest.json — the
// minimum bar for accepting a saved archive.
func zipHasManifest(data []byte) bool {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return false
	}
	_, ok := manifestFromZip(zr)
	return ok
}

// registerArchiveRoutes wires the archive endpoints onto mux, persisting under dir (created on first save).
func registerArchiveRoutes(mux *http.ServeMux, dir string) {
	mux.HandleFunc("PUT /archive/{id}", func(w http.ResponseWriter, r *http.Request) { handleArchiveSave(w, r, dir) })
	mux.HandleFunc("GET /archive/{id}", func(w http.ResponseWriter, r *http.Request) { handleArchiveGet(w, r, dir) })
	mux.HandleFunc("DELETE /archive/{id}", func(w http.ResponseWriter, r *http.Request) { handleArchiveDelete(w, r, dir) })
	mux.HandleFunc("GET /archives", func(w http.ResponseWriter, r *http.Request) { handleArchiveList(w, r, dir) })
}

func handleArchiveSave(w http.ResponseWriter, r *http.Request, dir string) {
	id := r.PathValue("id")
	if !validCaseID(id) {
		writeErr(w, http.StatusBadRequest, "invalid_id", "caseId must match [a-z0-9-], 1-64 chars")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxArchiveBody)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "archive exceeds 200 MiB")
		} else {
			writeErr(w, http.StatusBadRequest, "bad_request", "could not read request body")
		}
		return
	}
	// Reject anything that isn't a readable zip with a manifest.json — keeps the store sane and the
	// listing reliable (Go never has to defend against arbitrary bytes masquerading as a case).
	if !zipHasManifest(data) {
		writeErr(w, http.StatusBadRequest, "bad_archive", "body is not a valid case archive (zip with manifest.json)")
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "io_error", "cannot create archives directory")
		return
	}
	// Atomic write: temp file in the SAME dir, then rename (so a partial write never leaves a corrupt .zip).
	tmp, err := os.CreateTemp(dir, id+".*.tmp")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "io_error", "cannot create temp file")
		return
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		writeErr(w, http.StatusInternalServerError, "io_error", "cannot write archive")
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		writeErr(w, http.StatusInternalServerError, "io_error", "cannot finalize archive")
		return
	}
	if err := os.Rename(tmpName, archivePath(dir, id)); err != nil {
		_ = os.Remove(tmpName)
		writeErr(w, http.StatusInternalServerError, "io_error", "cannot store archive")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "caseId": id})
}

func handleArchiveGet(w http.ResponseWriter, r *http.Request, dir string) {
	id := r.PathValue("id")
	if !validCaseID(id) {
		writeErr(w, http.StatusBadRequest, "invalid_id", "caseId must match [a-z0-9-], 1-64 chars")
		return
	}
	real, ok := safeArchiveFile(dir, id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(real)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private") // archives carry PII
	_, _ = io.Copy(w, f)
}

func handleArchiveDelete(w http.ResponseWriter, r *http.Request, dir string) {
	id := r.PathValue("id")
	if !validCaseID(id) {
		writeErr(w, http.StatusBadRequest, "invalid_id", "caseId must match [a-z0-9-], 1-64 chars")
		return
	}
	real, ok := safeArchiveFile(dir, id)
	if !ok {
		http.NotFound(w, r) // missing, or a symlink escaping the dir — refuse either way
		return
	}
	if err := os.Remove(real); err != nil {
		writeErr(w, http.StatusInternalServerError, "io_error", "cannot delete archive")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleArchiveList(w http.ResponseWriter, r *http.Request, dir string) {
	out := []manifestMeta{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, http.StatusOK, out) // no dir yet → empty list (not an error)
		return
	}
	for _, e := range entries {
		// Skip dirs, non-.zip, and symlinks (a symlink could point outside the archives dir).
		if e.IsDir() || e.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(e.Name(), ".zip") {
			continue
		}
		if m, ok := readManifest(filepath.Join(dir, e.Name())); ok {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt }) // newest first
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
