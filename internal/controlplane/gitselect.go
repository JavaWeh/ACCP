package controlplane

import (
	"errors"
	"strings"

	"github.com/JavaWeh/ACCP/internal/gitprovider"
)

// repositoryToken decrypts the stored read-only access token for a repository,
// if any. An empty result means no per-repository credential is stored — the
// GitHub path then falls back to the server environment token carried by the
// injected provider. The ciphertext never leaves the server.
func (q *request) repositoryToken(repoID string) (string, error) {
	var enc *string
	err := q.tx.QueryRow(q.http.Context(), `SELECT access_token FROM repositories WHERE id=$1 AND project_id=$2 AND organization_id=$3`, repoID, q.project, q.org).Scan(&enc)
	if err != nil {
		return "", err
	}
	if enc == nil || *enc == "" {
		return "", nil
	}
	if q.server.signer == nil {
		return "", fail(503, "GIT_CREDENTIAL_UNAVAILABLE", "The server is not configured to read repository credentials.")
	}
	return q.server.signer.OpenSecret("repo_access_token", *enc)
}

// gitLab builds a GitLab provider bound to the repository's host and its
// decrypted per-repository token.
func (q *request) gitLab(repo Object) (*gitprovider.GitLab, error) {
	host, _, err := gitprovider.GitLabRepository(textValue(repo, "url"))
	if err != nil {
		return nil, fail(422, "INVALID_REPOSITORY", "The stored repository URL is not a valid GitLab URL.")
	}
	token, err := q.repositoryToken(textValue(repo, "id"))
	if err != nil {
		return nil, err
	}
	return &gitprovider.GitLab{Host: host, Token: token}, nil
}

// gitProvider selects a verification provider by the repository's provider_id.
// GitHub keeps using the injected server provider (its environment token) for
// zero regression; GitLab gets a per-repository provider.
func (q *request) gitProvider(repo Object) (gitprovider.Provider, error) {
	if textValue(repo, "provider_id") == "gitlab" {
		return q.gitLab(repo)
	}
	if p := q.server.options.GitProvider; p != nil {
		return p, nil
	}
	return &gitprovider.GitHub{}, nil
}

func (q *request) gitFileProvider(repo Object) (gitprovider.FileProvider, error) {
	if textValue(repo, "provider_id") == "gitlab" {
		return q.gitLab(repo)
	}
	if p, ok := q.server.options.GitProvider.(gitprovider.FileProvider); ok {
		return p, nil
	}
	if q.server.options.GitProvider != nil {
		return nil, fail(503, "GIT_SOURCE_UNAVAILABLE", "The configured Git provider cannot read source files.")
	}
	return &gitprovider.GitHub{}, nil
}

func (q *request) gitProber(repo Object) (gitprovider.Prober, error) {
	if textValue(repo, "provider_id") == "gitlab" {
		return q.gitLab(repo)
	}
	if p, ok := q.server.options.GitProvider.(gitprovider.Prober); ok {
		return p, nil
	}
	if q.server.options.GitProvider != nil {
		return nil, fail(503, "GIT_SOURCE_UNAVAILABLE", "The configured Git provider cannot run a read-only test pull.")
	}
	return &gitprovider.GitHub{}, nil
}

// testRepositoryPull is the ADMIN-only read-only "test pull": it probes the
// repository with its stored credential and returns a content digest or a
// stable classification (AUTH | NOT_FOUND | NETWORK). It never echoes the
// token and never writes.
func testRepositoryPull(q *request) (reply, error) {
	repo, err := readDocument(q, "repositories", q.http.PathValue("rid"))
	if err != nil {
		return reply{}, err
	}
	prober, err := q.gitProber(repo)
	if err != nil {
		return reply{}, err
	}
	path := strings.TrimSpace(textValue(q.body, "path"))
	revision := strings.TrimSpace(textValue(q.body, "revision"))
	digest, resolved, perr := prober.Probe(q.http.Context(), textValue(repo, "url"), textValue(repo, "default_branch"), path, revision)
	if perr != nil {
		code := gitprovider.ProbeNetwork
		var pe *gitprovider.ProbeError
		if errors.As(perr, &pe) {
			code = pe.Code
		}
		return reply{status: 200, body: Object{"ok": false, "code": code}}, nil
	}
	return reply{status: 200, body: Object{"ok": true, "content_digest": digest, "revision": resolved}}, nil
}
