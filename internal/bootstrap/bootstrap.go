// Package bootstrap provisions the initial human identity mapping. It is an operator command,
// never an unauthenticated API or automatic registration from token claims.
package bootstrap

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Membership struct {
	ProjectID string   `json:"project_id"`
	Roles     []string `json:"roles"`
}
type Human struct {
	ID          string       `json:"id"`
	Issuer      string       `json:"issuer"`
	Subject     string       `json:"subject"`
	DisplayName string       `json:"display_name"`
	Memberships []Membership `json:"memberships"`
}
type Repository struct {
	ID            string `json:"id"`
	ProviderID    string `json:"provider_id"`
	URL           string `json:"url"`
	DefaultBranch string `json:"default_branch"`
}
type Project struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Repository Repository `json:"repository"`
}
type Organization struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Spec struct {
	Organization Organization `json:"organization"`
	Projects     []Project    `json:"projects"`
	Humans       []Human      `json:"humans"`
}
type Credential struct {
	UserID    string    `json:"user_id"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.:-]{1,127}$`)

func Validate(spec Spec) error {
	if !identifier.MatchString(spec.Organization.ID) || spec.Organization.Name == "" || len(spec.Projects) == 0 || len(spec.Humans) == 0 {
		return fmt.Errorf("organization, projects and human members are required")
	}
	projects := map[string]bool{}
	admins := map[string]bool{}
	users := map[string]bool{}
	for _, p := range spec.Projects {
		u, err := url.Parse(p.Repository.URL)
		if !identifier.MatchString(p.ID) || p.Name == "" || projects[p.ID] || !identifier.MatchString(p.Repository.ID) || !identifier.MatchString(p.Repository.ProviderID) || p.Repository.DefaultBranch == "" || err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return fmt.Errorf("invalid or duplicate project/repository")
		}
		projects[p.ID] = true
	}
	for _, h := range spec.Humans {
		if !identifier.MatchString(h.ID) || users[h.ID] || h.Subject == "" || h.DisplayName == "" || h.Issuer == "" || len(h.Memberships) == 0 {
			return fmt.Errorf("invalid or duplicate human mapping")
		}
		users[h.ID] = true
		seen := map[string]bool{}
		for _, m := range h.Memberships {
			if !projects[m.ProjectID] || seen[m.ProjectID] || len(m.Roles) == 0 {
				return fmt.Errorf("invalid project membership")
			}
			seen[m.ProjectID] = true
			roles := map[string]bool{}
			for _, r := range m.Roles {
				if roles[r] {
					return fmt.Errorf("duplicate role")
				}
				roles[r] = true
				switch r {
				case "ADMIN":
					admins[m.ProjectID] = true
				case "MEMBER", "REVIEWER", "VIEWER":
				default:
					return fmt.Errorf("invalid role")
				}
			}
		}
	}
	for p := range projects {
		if !admins[p] {
			return fmt.Errorf("every project requires a human administrator")
		}
	}
	return nil
}

func Apply(ctx context.Context, pool *pgxpool.Pool, spec Spec, development bool) ([]Credential, error) {
	if err := Validate(spec); err != nil {
		return nil, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1094927185)`); err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM organizations`).Scan(&count); err != nil {
		return nil, err
	}
	if count != 0 {
		return nil, fmt.Errorf("bootstrap requires an empty database; existing data is never overwritten")
	}
	if _, err = tx.Exec(ctx, `INSERT INTO organizations(id,name) VALUES($1,$2)`, spec.Organization.ID, spec.Organization.Name); err != nil {
		return nil, err
	}
	for _, p := range spec.Projects {
		if _, err = tx.Exec(ctx, `INSERT INTO projects(id,organization_id,name) VALUES($1,$2,$3)`, p.ID, spec.Organization.ID, p.Name); err != nil {
			return nil, err
		}
		doc := map[string]any{"id": p.Repository.ID, "project_id": p.ID, "organization_id": spec.Organization.ID, "provider_id": p.Repository.ProviderID, "url": p.Repository.URL, "default_branch": p.Repository.DefaultBranch}
		data, err := json.Marshal(doc)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO repositories(id,project_id,organization_id,document) VALUES($1,$2,$3,$4)`, p.Repository.ID, p.ID, spec.Organization.ID, data); err != nil {
			return nil, err
		}
	}
	credentials := []Credential{}
	for _, h := range spec.Humans {
		if development && h.Issuer != "urn:accp:development" {
			return nil, fmt.Errorf("development bootstrap requires development identities")
		}
		if !development {
			u, err := url.Parse(h.Issuer)
			if err != nil || u.Scheme != "https" || u.Host == "" {
				return nil, fmt.Errorf("human mapping requires HTTPS OIDC issuer")
			}
		}
		if _, err = tx.Exec(ctx, `INSERT INTO human_users(id,organization_id,issuer,subject,display_name) VALUES($1,$2,$3,$4,$5)`, h.ID, spec.Organization.ID, h.Issuer, h.Subject, h.DisplayName); err != nil {
			return nil, err
		}
		for _, m := range h.Memberships {
			if _, err = tx.Exec(ctx, `INSERT INTO memberships(project_id,organization_id,user_id,roles) VALUES($1,$2,$3,$4)`, m.ProjectID, spec.Organization.ID, h.ID, m.Roles); err != nil {
				return nil, err
			}
		}
		if development {
			var bytes [32]byte
			if _, err = rand.Read(bytes[:]); err != nil {
				return nil, err
			}
			token := base64.RawURLEncoding.EncodeToString(bytes[:])
			expiry := time.Now().UTC().Add(7 * 24 * time.Hour)
			if _, err = tx.Exec(ctx, `INSERT INTO development_tokens(digest,issuer,subject,expires_at) VALUES($1,$2,$3,$4)`, auth.Digest(token), h.Issuer, h.Subject, expiry); err != nil {
				return nil, err
			}
			credentials = append(credentials, Credential{h.ID, token, expiry})
		}
	}
	return credentials, tx.Commit(ctx)
}

func DevelopmentSpec() Spec {
	member := []Membership{{ProjectID: "project_demo", Roles: []string{"MEMBER", "REVIEWER"}}}
	return Spec{Organization: Organization{ID: "org_demo", Name: "ACCP development"}, Projects: []Project{{ID: "project_demo", Name: "Demo project", Repository: Repository{ID: "repo_demo", ProviderID: "git", URL: "https://github.com/JavaWeh/ACCP", DefaultBranch: "main"}}}, Humans: []Human{
		{ID: "user_alice", Issuer: "urn:accp:development", Subject: "alice", DisplayName: "Alice", Memberships: []Membership{{ProjectID: "project_demo", Roles: []string{"ADMIN", "MEMBER", "REVIEWER"}}}},
		{ID: "user_bob", Issuer: "urn:accp:development", Subject: "bob", DisplayName: "Bob", Memberships: member},
	}}
}
