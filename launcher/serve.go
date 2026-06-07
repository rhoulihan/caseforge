// The `serve` subcommand: hosts the static SPA on 127.0.0.1 and exposes the anonymization system
// utility over localhost HTTP so the browser routes extracted text through the Go replacer (real
// phrases never enter an AI prompt). Security-first: localhost-only bind, MaxBytesReader body cap,
// explicit path-traversal guard, slug-conflict hard-fail + no-store on /deanonymize. Stateless:
// each request parses its own (pre-expanded) map. Stdlib only.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/rhoulihan/caseforge/launcher/anon"
)

const maxBody = 10 << 20 // 10 MiB

type serveConfig struct {
	appDir string
	port   int
	noOpen bool
}

type anonReq struct {
	Map  string `json:"map"`
	Text string `json:"text"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": msg, "code": code})
}

// decodeReq enforces the body-size cap BEFORE reading (MaxBytesReader), then parses the JSON.
func decodeReq(w http.ResponseWriter, r *http.Request) (anonReq, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	var req anonReq
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds 10 MiB")
			return req, false
		}
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return req, false
	}
	// Reject trailing data after the JSON object — a well-formed request is exactly one object.
	if dec.More() {
		writeErr(w, http.StatusBadRequest, "bad_request", "unexpected trailing data after JSON body")
		return req, false
	}
	return req, true
}

// parseEntries structurally parses the TSV map (missing tab / empty phrase / empty slug → 400).
// It deliberately does NOT call anon.Validate: the map arrives PRE-EXPANDED by the SPA, where
// case/whitespace/NFC variants legitimately share one slug (John/john/JOHN → CF_P_01). Validate
// rejects duplicate slugs (it guards invertibility of an UN-expanded table) and would reject every
// expanded map. The endpoint is a dumb literal matcher; the SPA's validateMap owns semantic checks.
func parseEntries(w http.ResponseWriter, req anonReq) ([]anon.Entry, bool) {
	entries, err := anon.ParseMap(req.Map)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_map", err.Error())
		return nil, false
	}
	return entries, true
}

func handleAnonymize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	req, ok := decodeReq(w, r)
	if !ok {
		return
	}
	entries, ok := parseEntries(w, req)
	if !ok {
		return
	}
	// Fail closed if a slug literal already sits in the RAW source: anonymizing would introduce a
	// second, indistinguishable occurrence, and the later deanonymize pass would corrupt the
	// originally-present one. Detection must happen here (pre-substitution) — the deanonymize input
	// legitimately contains slugs, so the check cannot live there.
	if conflicts := anon.ScanForSlugs(req.Text, entries); len(conflicts) > 0 {
		writeErr(w, http.StatusBadRequest, "slug_conflict", "slug(s) already present in source text (regenerate them): "+strings.Join(conflicts, ", "))
		return
	}
	text, count := anon.AnonymizeN(req.Text, entries)
	writeJSON(w, http.StatusOK, map[string]any{"text": text, "count": count})
}

func handleDeanonymize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	req, ok := decodeReq(w, r)
	if !ok {
		return
	}
	entries, ok := parseEntries(w, req)
	if !ok {
		return
	}
	// The reverse map may carry duplicate slugs (variants share a slug); DeanonymizeN resolves them
	// first-wins (longest-first, stable), recovering a deterministic canonical phrase. No slug-conflict
	// check here: the input is LLM-returned text that is SUPPOSED to be full of slugs.
	// The response carries real phrases — never cache or log it.
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
	text, count := anon.DeanonymizeN(req.Text, entries)
	writeJSON(w, http.StatusOK, map[string]any{"text": text, "count": count})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// staticHandler serves files from appDir with an explicit boundary check (no bare FileServer).
func staticHandler(appDir string) http.Handler {
	// Resolve the root ONCE (abs + symlinks) so the boundary comparison below is apples-to-apples
	// even when appDir itself sits under a symlink (e.g. /tmp -> /private/tmp on macOS).
	root, err := filepath.Abs(appDir)
	if err != nil {
		root = appDir
	}
	if resolved, e := filepath.EvalSymlinks(root); e == nil {
		root = resolved
	}
	sep := string(os.PathSeparator)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
			return
		}
		upath := r.URL.Path
		if upath == "/" || upath == "" {
			upath = "/index.html"
		}
		clean := filepath.Clean("/" + strings.TrimPrefix(upath, "/")) // collapses .. against root
		full := filepath.Join(root, filepath.FromSlash(clean))
		// Resolve symlinks to a concrete path, then validate AND open THAT SAME path — closing the
		// TOCTOU window where a symlink checked here could be repointed before the open. EvalSymlinks
		// also fails for missing/broken targets (-> 404). The resolved real path is the only one we
		// ever touch, so the boundary check and the open can never disagree.
		real, err := filepath.EvalSymlinks(full)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		rel, err := filepath.Rel(root, real)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+sep) {
			http.NotFound(w, r)
			return
		}
		info, err := os.Stat(real)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if ct := mime.TypeByExtension(filepath.Ext(real)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		f, err := os.Open(real)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		_, _ = io.Copy(w, f) // client may disconnect mid-stream; headers are already sent (idiomatic, cf. http.ServeContent)
	})
}

// hasDotDot reports whether any path segment is exactly ".." (handles / and \ separators).
func hasDotDot(p string) bool {
	if !strings.Contains(p, "..") {
		return false
	}
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return true
		}
	}
	return false
}

// archivesDir is where business-case .zip archives are stored (created on first save).
func archivesDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "CaseForge", "archives")
	}
	return filepath.Join(os.TempDir(), "CaseForge", "archives")
}

func newMux(appDir, archiveDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/anonymize", handleAnonymize)
	mux.HandleFunc("/deanonymize", handleDeanonymize)
	mux.HandleFunc("/health", handleHealth)
	registerArchiveRoutes(mux, archiveDir)
	mux.Handle("/", staticHandler(appDir))
	// Reject raw ".." traversal with a flat 404 BEFORE ServeMux can 301-redirect to a cleaned path.
	// (r.URL.Path is already percent-decoded, so %2e%2e is caught too.) Defense in depth on top of
	// the static handler's own boundary check.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hasDotDot(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func parseServeFlags(args []string) (serveConfig, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	appDir := fs.String("app-dir", "", "static SPA directory to serve")
	port := fs.Int("port", 8080, "localhost port")
	noOpen := fs.Bool("no-open", false, "do not open a browser")
	if err := fs.Parse(args); err != nil {
		return serveConfig{}, err
	}
	if *appDir == "" {
		return serveConfig{}, errors.New("--app-dir is required")
	}
	info, err := os.Stat(*appDir)
	if err != nil {
		return serveConfig{}, fmt.Errorf("--app-dir %q not found", *appDir)
	}
	if !info.IsDir() {
		return serveConfig{}, fmt.Errorf("--app-dir %q is not a directory", *appDir)
	}
	if *port < 1 || *port > 65535 {
		return serveConfig{}, fmt.Errorf("invalid --port %d", *port)
	}
	return serveConfig{appDir: *appDir, port: *port, noOpen: *noOpen}, nil
}

// listenLocal binds 127.0.0.1 ONLY — never 0.0.0.0 (no remote exposure; no --bind-addr flag).
func listenLocal(port int) (net.Listener, error) {
	return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
}

func openBrowser(url string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "windows":
		cmd, args = "cmd", []string{"/c", "start", "", url}
	case "darwin":
		cmd, args = "open", []string{url}
	default:
		cmd, args = "xdg-open", []string{url}
	}
	_ = exec.Command(cmd, args...).Start() // best-effort; failure (e.g. headless) is non-fatal
}

// serveCLI parses flags, binds localhost, opens a browser, and serves until SIGINT/SIGTERM.
// Returns the process exit code: 0 clean · 1 startup error · 2 bad flags.
func serveCLI(args []string) int {
	cfg, err := parseServeFlags(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 2
	}
	ln, err := listenLocal(cfg.port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot bind 127.0.0.1:%d: %v\n", cfg.port, err)
		return 1
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", cfg.port)
	// ReadHeaderTimeout caps slow-header (slowloris) clients; bodies are separately capped by MaxBytesReader.
	srv := &http.Server{Handler: newMux(cfg.appDir, archivesDir()), ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("serving on %s from %s\n", url, cfg.appDir)
	if !cfg.noOpen {
		go openBrowser(url)
	}
	idle := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			// Drain window elapsed — force-close any remaining connections before the process exits.
			fmt.Fprintf(os.Stderr, "graceful shutdown timed out, forcing close: %v\n", err)
			_ = srv.Close()
		}
		close(idle)
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	<-idle
	return 0
}
