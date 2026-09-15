package auth

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Identity struct{ Issuer, Subject string }
type Authenticator interface {
	Authenticate(context.Context, string) (Identity, error)
}
type OIDC struct {
	verifier *oidc.IDTokenVerifier
	client   *http.Client
}

func NewOIDC(ctx context.Context, issuer, audience string) (*OIDC, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	ctx = oidc.ClientContext(ctx, client)
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery failed")
	}
	return &OIDC{verifier: provider.Verifier(&oidc.Config{ClientID: audience, SupportedSigningAlgs: []string{"RS256"}}), client: client}, nil
}

func (a *OIDC) Authenticate(ctx context.Context, token string) (Identity, error) {
	claims, err := a.verifier.Verify(oidc.ClientContext(ctx, a.client), token)
	if err != nil || claims.Subject == "" {
		return Identity{}, errors.New("invalid bearer token")
	}
	return Identity{Issuer: claims.Issuer, Subject: claims.Subject}, nil
}

type Development struct{ Pool *pgxpool.Pool }

func (a Development) Authenticate(ctx context.Context, token string) (Identity, error) {
	var identity Identity
	err := a.Pool.QueryRow(ctx, `SELECT issuer,subject FROM development_tokens WHERE digest=$1 AND expires_at>now()`, Digest(token)).Scan(&identity.Issuer, &identity.Subject)
	if err != nil {
		return Identity{}, errors.New("invalid development token")
	}
	return identity, nil
}

func Digest(value string) string { return fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(value))) }
