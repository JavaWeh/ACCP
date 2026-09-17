package controlplane

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConsoleCSPAllowsIssuerOriginWithoutPathRestriction(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{mux: http.NewServeMux(), options: Options{WebDirectory: dir, OIDCIssuer: "https://idp.example:8443/realms/company"}}
	s.mountConsole()
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	csp := w.Header().Get("Content-Security-Policy")
	if w.Code != 200 || !strings.Contains(csp, "connect-src 'self' https://idp.example:8443;") || strings.Contains(csp, "/realms/") {
		t.Fatalf("unexpected CSP: %s", csp)
	}
	if !strings.Contains(csp, "script-src 'self';") || !strings.Contains(csp, "frame-ancestors 'none';") {
		t.Fatal("unrelated restrictions changed")
	}
}
