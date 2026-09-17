package controlplane

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) mountConsole() {
	connectSource := ""
	if issuer, err := url.Parse(s.options.OIDCIssuer); err == nil && issuer.Scheme == "https" && issuer.Host != "" && issuer.User == nil {
		connectSource = " " + issuer.Scheme + "://" + issuer.Host
	}
	s.mux.HandleFunc("GET /api/v1/auth/config", func(w http.ResponseWriter, r *http.Request) {
		respond(w, reply{status: 200, body: Object{"mode": s.options.AuthMode, "issuer": s.options.OIDCIssuer, "client_id": s.options.OIDCClientID, "public_url": s.options.PublicURL}})
	})
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || s.options.WebDirectory == "" || strings.HasPrefix(r.URL.Path, "/api/") {
			writeProblem(w, newID("trace"), fail(404, "NOT_FOUND", "Route not found."))
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"+connectSource+"; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		path := filepath.Join(s.options.WebDirectory, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
		root, _ := filepath.Abs(s.options.WebDirectory)
		absolute, _ := filepath.Abs(path)
		if absolute != root && !strings.HasPrefix(absolute, root+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		if info, e := os.Stat(path); e != nil || info.IsDir() {
			path = filepath.Join(root, "index.html")
		}
		http.ServeFile(w, r, path)
	})
}
