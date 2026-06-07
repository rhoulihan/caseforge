package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeCaseZip builds a minimal valid case archive: a zip with a manifest.json carrying the given meta.
func makeCaseZip(t *testing.T, caseID, company, updatedAt string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mf, _ := zw.Create("manifest.json")
	_ = json.NewEncoder(mf).Encode(map[string]any{
		"schemaVersion": 1, "caseId": caseID, "companyName": company, "provider": "claude",
		"status": "generated", "updatedAt": updatedAt, "currentVersion": "001",
	})
	vf, _ := zw.Create("versions/001/docmodel.json")
	_, _ = vf.Write([]byte(`{"companyName":"` + company + `"}`))
	if err := zw.Close(); err != nil {
		t.Fatalf("zip: %v", err)
	}
	return buf.Bytes()
}

func archiveTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	srv := httptest.NewServer(newMux(t.TempDir(), dir))
	t.Cleanup(srv.Close)
	return srv, dir
}

func do(t *testing.T, method, url string, body []byte) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatalf("req: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return res
}

func TestArchiveSaveGetRoundTrip(t *testing.T) {
	srv, dir := archiveTestServer(t)
	zipBytes := makeCaseZip(t, "northwind-mutual-abc123", "Northwind Mutual", "2026-06-07T18:00:00Z")

	res := do(t, "PUT", srv.URL+"/archive/northwind-mutual-abc123", zipBytes)
	if res.StatusCode != 200 {
		t.Fatalf("save status = %d", res.StatusCode)
	}
	res.Body.Close()

	// It landed on disk as <id>.zip.
	if _, err := os.Stat(filepath.Join(dir, "northwind-mutual-abc123.zip")); err != nil {
		t.Fatalf("archive not written: %v", err)
	}

	// GET returns the exact bytes.
	res = do(t, "GET", srv.URL+"/archive/northwind-mutual-abc123", nil)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("get status=%d ct=%q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(got, zipBytes) {
		t.Fatalf("round-trip bytes differ (%d vs %d)", len(got), len(zipBytes))
	}
}

func TestArchiveListReadsManifestsNewestFirstAndSkipsJunk(t *testing.T) {
	srv, dir := archiveTestServer(t)
	do(t, "PUT", srv.URL+"/archive/case-old", makeCaseZip(t, "case-old", "Old Co", "2026-06-01T00:00:00Z")).Body.Close()
	do(t, "PUT", srv.URL+"/archive/case-new", makeCaseZip(t, "case-new", "New Co", "2026-06-07T00:00:00Z")).Body.Close()
	// A non-archive file in the dir must be skipped, not crash the listing.
	_ = os.WriteFile(filepath.Join(dir, "garbage.zip"), []byte("not a zip"), 0o644)

	res := do(t, "GET", srv.URL+"/archives", nil)
	if res.StatusCode != 200 {
		t.Fatalf("list status = %d", res.StatusCode)
	}
	var list []map[string]any
	_ = json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list) != 2 {
		t.Fatalf("expected 2 archives (junk skipped), got %d", len(list))
	}
	if list[0]["caseId"] != "case-new" || list[1]["caseId"] != "case-old" {
		t.Fatalf("expected newest-first ordering, got %v / %v", list[0]["caseId"], list[1]["caseId"])
	}
	if list[0]["companyName"] != "New Co" {
		t.Fatalf("manifest company not surfaced: %v", list[0]["companyName"])
	}
}

func TestArchiveListEmptyWhenNoDir(t *testing.T) {
	srv := httptest.NewServer(newMux(t.TempDir(), filepath.Join(t.TempDir(), "does-not-exist")))
	t.Cleanup(srv.Close)
	res := do(t, "GET", srv.URL+"/archives", nil)
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("expected empty list, got status=%d body=%q", res.StatusCode, body)
	}
}

func TestArchiveDelete(t *testing.T) {
	srv, _ := archiveTestServer(t)
	do(t, "PUT", srv.URL+"/archive/case-x", makeCaseZip(t, "case-x", "X", "2026-06-07T00:00:00Z")).Body.Close()
	if res := do(t, "DELETE", srv.URL+"/archive/case-x", nil); res.StatusCode != 200 {
		t.Fatalf("delete status = %d", res.StatusCode)
	} else {
		res.Body.Close()
	}
	if res := do(t, "GET", srv.URL+"/archive/case-x", nil); res.StatusCode != 404 {
		t.Fatalf("expected 404 after delete, got %d", res.StatusCode)
	} else {
		res.Body.Close()
	}
	if res := do(t, "DELETE", srv.URL+"/archive/case-x", nil); res.StatusCode != 404 {
		t.Fatalf("expected 404 deleting missing, got %d", res.StatusCode)
	} else {
		res.Body.Close()
	}
}

func TestArchiveRejectsBadCaseID(t *testing.T) {
	srv, dir := archiveTestServer(t)
	for _, id := range []string{"..", "a..b", "UPPER", "has space", "a/b"} {
		// The id is in the path; build the URL raw so the server sees it. Path-traversal ids are caught
		// either by the dot-dot guard (404) or caseId validation (400) — never a 200 / never a write.
		res := do(t, "PUT", srv.URL+"/archive/"+id, makeCaseZip(t, "ok", "Co", "2026-06-07T00:00:00Z"))
		if res.StatusCode == 200 {
			t.Fatalf("bad id %q was accepted", id)
		}
		res.Body.Close()
	}
	// Nothing escaped the archives dir.
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("bad ids wrote %d files", len(entries))
	}
}

func TestArchiveRefusesSymlinkEscape(t *testing.T) {
	dir := t.TempDir()
	srv := httptest.NewServer(newMux(t.TempDir(), dir))
	t.Cleanup(srv.Close)
	// A secret file OUTSIDE the archives dir, and a symlink INSIDE it (valid-looking caseId) pointing at it.
	secret := filepath.Join(t.TempDir(), "secret.txt")
	_ = os.WriteFile(secret, []byte("TOP SECRET PII"), 0o600)
	if err := os.Symlink(secret, filepath.Join(dir, "leak.zip")); err != nil {
		t.Skipf("symlinks unsupported here: %v", err)
	}
	// GET must NOT follow the symlink out of the dir.
	res := do(t, "GET", srv.URL+"/archive/leak", nil)
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 404 || strings.Contains(string(body), "TOP SECRET") {
		t.Fatalf("symlink escape served outside file: status=%d body=%q", res.StatusCode, body)
	}
	// And the listing must skip the symlink rather than read through it.
	res = do(t, "GET", srv.URL+"/archives", nil)
	var list []map[string]any
	_ = json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list) != 0 {
		t.Fatalf("symlink leaked into the listing: %d entries", len(list))
	}
}

func TestArchiveRejectsNonZipBody(t *testing.T) {
	srv, _ := archiveTestServer(t)
	res := do(t, "PUT", srv.URL+"/archive/case-bad", []byte("definitely not a zip"))
	if res.StatusCode != 400 {
		t.Fatalf("expected 400 for non-zip body, got %d", res.StatusCode)
	}
	res.Body.Close()
}

func TestArchiveRejectsZipWithoutManifest(t *testing.T) {
	srv, _ := archiveTestServer(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, _ := zw.Create("notes.txt")
	_, _ = f.Write([]byte("hi"))
	_ = zw.Close()
	res := do(t, "PUT", srv.URL+"/archive/case-nomani", buf.Bytes())
	if res.StatusCode != 400 {
		t.Fatalf("expected 400 for zip without manifest, got %d", res.StatusCode)
	}
	res.Body.Close()
}
