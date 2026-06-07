package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func post(t *testing.T, srv *httptest.Server, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return resp, out
}

func newTestServer(t *testing.T, appDir string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(newMux(appDir, t.TempDir()))
	t.Cleanup(srv.Close)
	return srv
}

func TestAnonymizeValid(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	resp, out := post(t, srv, "/anonymize", `{"map":"John Doe\tCF_PERSON_01","text":"Hello John Doe"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if out["text"] != "Hello CF_PERSON_01" {
		t.Fatalf("text = %v", out["text"])
	}
	if out["count"].(float64) != 1 {
		t.Fatalf("count = %v", out["count"])
	}
	if strings.Contains(out["text"].(string), "John Doe") {
		t.Fatal("real phrase leaked into the anonymized response")
	}
}

func TestAnonymizeEmptyMapIsNoOp(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	resp, out := post(t, srv, "/anonymize", `{"map":"","text":"foo bar"}`)
	if resp.StatusCode != 200 || out["text"] != "foo bar" || out["count"].(float64) != 0 {
		t.Fatalf("expected no-op, got %d %v", resp.StatusCode, out)
	}
}

func TestAnonymizePreExpandedVariants(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	// The caller (TS buildMap) pre-expands variants; the endpoint matches literally.
	resp, out := post(t, srv, "/anonymize", `{"map":"John\tCF_P_01\njohn\tCF_P_01\nJOHN\tCF_P_01","text":"John john JOHN"}`)
	if resp.StatusCode != 200 || out["text"] != "CF_P_01 CF_P_01 CF_P_01" || out["count"].(float64) != 3 {
		t.Fatalf("variants not all replaced: %d %v", resp.StatusCode, out)
	}
}

func TestAnonymizeStateless(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	_, a := post(t, srv, "/anonymize", `{"map":"Acme\tCF_ORG_01","text":"Acme"}`)
	_, b := post(t, srv, "/anonymize", `{"map":"Globex\tCF_ORG_02","text":"Globex Acme"}`)
	if a["text"] != "CF_ORG_01" {
		t.Fatalf("first request: %v", a["text"])
	}
	if b["text"] != "CF_ORG_02 Acme" { // map A must not leak into request B
		t.Fatalf("second request leaked prior map: %v", b["text"])
	}
}

func TestAnonymizeMethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	resp, out := func() (*http.Response, map[string]any) {
		r, _ := http.Get(srv.URL + "/anonymize")
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		var o map[string]any
		_ = json.Unmarshal(b, &o)
		return r, o
	}()
	if resp.StatusCode != http.StatusMethodNotAllowed || out["code"] != "method_not_allowed" {
		t.Fatalf("expected 405 method_not_allowed, got %d %v", resp.StatusCode, out)
	}
}

func TestAnonymizeErrors(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	cases := []struct {
		name, body string
		status     int
		code       string
	}{
		{"malformed json", `not json`, 400, "bad_request"},
		{"bad tsv (no tab)", `{"map":"notab","text":"x"}`, 400, "invalid_map"},
		{"empty slug", `{"map":"A\t","text":"A"}`, 400, "invalid_map"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, out := post(t, srv, "/anonymize", c.body)
			if resp.StatusCode != c.status || out["code"] != c.code {
				t.Fatalf("got %d %v, want %d %s", resp.StatusCode, out, c.status, c.code)
			}
		})
	}
}

func TestAnonymizeBodyTooLarge(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	big := strings.Repeat("a", 11<<20)
	resp, out := post(t, srv, "/anonymize", `{"map":"","text":"`+big+`"}`)
	if resp.StatusCode != http.StatusRequestEntityTooLarge || out["code"] != "payload_too_large" {
		t.Fatalf("expected 413 payload_too_large, got %d %v", resp.StatusCode, out)
	}
}

func TestDeanonymizeRoundTrip(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	m := `{"map":"John Doe\tCF_PERSON_01","text":"Hello CF_PERSON_01"}`
	resp, out := post(t, srv, "/deanonymize", m)
	if resp.StatusCode != 200 || out["text"] != "Hello John Doe" || out["count"].(float64) != 1 {
		t.Fatalf("deanonymize: %d %v", resp.StatusCode, out)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Fatalf("deanonymize response must be no-store, got %q", cc)
	}
}

func TestAnonymizeSlugConflict(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	// CF_PERSON_01 already sits in the RAW source: anonymizing John→CF_PERSON_01 would create a
	// second occurrence, and the later reverse pass would corrupt the originally-present one.
	// Detection belongs on /anonymize (pre-substitution), not /deanonymize.
	resp, out := post(t, srv, "/anonymize", `{"map":"John\tCF_PERSON_01","text":"CF_PERSON_01 met John"}`)
	if resp.StatusCode != 400 || out["code"] != "slug_conflict" {
		t.Fatalf("expected 400 slug_conflict, got %d %v", resp.StatusCode, out)
	}
}

func TestDeanonymizeAcceptsSharedSlugs(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	// A pre-expanded reverse map carries duplicate slugs (John/john share CF_P_01); first-wins
	// recovers a deterministic canonical phrase. This must NOT be rejected as a duplicate slug.
	resp, out := post(t, srv, "/deanonymize", `{"map":"John\tCF_P_01\njohn\tCF_P_01","text":"hi CF_P_01"}`)
	if resp.StatusCode != 200 || out["text"] != "hi John" || out["count"].(float64) != 1 {
		t.Fatalf("shared-slug deanonymize: %d %v", resp.StatusCode, out)
	}
}

func TestHealth(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	r, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(r.Body).Decode(&out)
	if r.StatusCode != 200 || out["status"] != "ok" {
		t.Fatalf("health: %d %v", r.StatusCode, out)
	}
}

func TestStaticServing(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>hi</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "style.css"), []byte("body{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, dir)

	get := func(path string) (*http.Response, string) {
		r, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		return r, string(b)
	}

	if r, body := get("/"); r.StatusCode != 200 || !strings.Contains(body, "hi") || !strings.Contains(r.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("GET / : %d ct=%q body=%q", r.StatusCode, r.Header.Get("Content-Type"), body)
	}
	if r, _ := get("/style.css"); r.StatusCode != 200 || !strings.Contains(r.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("GET /style.css ct=%q status=%d", r.Header.Get("Content-Type"), r.StatusCode)
	}
	if r, _ := get("/nonexistent.js"); r.StatusCode != 404 {
		t.Fatalf("GET /nonexistent.js status=%d", r.StatusCode)
	}
	if r, _ := get("/../../etc/passwd"); r.StatusCode != 404 {
		t.Fatalf("path traversal not blocked: status=%d", r.StatusCode)
	}
}

func TestStaticTraversalReturns404NotRedirect(t *testing.T) {
	h := newMux(t.TempDir(), t.TempDir())
	req := httptest.NewRequest("GET", "/", nil)
	req.URL.Path = "/../../etc/passwd" // raw, uncleaned (a real client pre-cleans; this does not)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("raw traversal must be 404, got %d (Location=%q)", rec.Code, rec.Header().Get("Location"))
	}
}

func TestHealthMethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	resp, out := post(t, srv, "/health", "")
	if resp.StatusCode != http.StatusMethodNotAllowed || out["code"] != "method_not_allowed" {
		t.Fatalf("POST /health should be 405, got %d %v", resp.StatusCode, out)
	}
}

func TestAnonymizeRejectsTrailingData(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	resp, out := post(t, srv, "/anonymize", `{"map":"","text":"x"} GARBAGE`)
	if resp.StatusCode != 400 || out["code"] != "bad_request" {
		t.Fatalf("trailing data should be 400 bad_request, got %d %v", resp.StatusCode, out)
	}
}

func TestStaticSymlinkEscapeBlocked(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt") // a file OUTSIDE app-dir
	if err := os.WriteFile(outside, []byte("TOP-SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "evil.txt")); err != nil {
		t.Skipf("symlinks unsupported on this platform: %v", err)
	}
	srv := newTestServer(t, dir)
	r, err := http.Get(srv.URL + "/evil.txt")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusNotFound || strings.Contains(string(b), "SECRET") {
		t.Fatalf("symlink escaping app-dir must be blocked: status=%d body=%q", r.StatusCode, string(b))
	}
}

func TestStaticSymlinkInsideRootServed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "real.css"), []byte("body{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "real.css"), filepath.Join(dir, "alias.css")); err != nil {
		t.Skipf("symlinks unsupported on this platform: %v", err)
	}
	srv := newTestServer(t, dir)
	r, err := http.Get(srv.URL + "/alias.css")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 200 || !strings.Contains(r.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("a symlink INSIDE app-dir should serve normally, got %d ct=%q", r.StatusCode, r.Header.Get("Content-Type"))
	}
}

func TestParseServeFlags(t *testing.T) {
	dir := t.TempDir()
	if cfg, err := parseServeFlags([]string{"--app-dir", dir, "--port", "9090", "--no-open"}); err != nil || cfg.port != 9090 || cfg.appDir != dir || !cfg.noOpen {
		t.Fatalf("valid flags: %+v err=%v", cfg, err)
	}
	if _, err := parseServeFlags([]string{"--port", "8080"}); err == nil {
		t.Fatal("expected error for missing --app-dir")
	}
	if _, err := parseServeFlags([]string{"--app-dir", dir, "--port", "abc"}); err == nil {
		t.Fatal("expected error for non-numeric --port")
	}
	file := filepath.Join(dir, "f.txt")
	_ = os.WriteFile(file, []byte("x"), 0o644)
	if _, err := parseServeFlags([]string{"--app-dir", file}); err == nil {
		t.Fatal("expected error for --app-dir that is a file")
	}
}

func TestListenLocalIsLoopback(t *testing.T) {
	ln, err := listenLocal(0)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	tcp, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !tcp.IP.IsLoopback() {
		t.Fatalf("listener must bind loopback only, got %v", ln.Addr())
	}
}
