// Package client is a vendor-neutral ACCP Collaboration Protocol 0.2 HTTP client.
package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Object = map[string]any
type Client struct {
	origin, token string
	http          *http.Client
}
type WriteOptions struct {
	IdempotencyKey        string
	Version, FencingToken int64
}
type Response struct {
	Status int
	ETag   string
	Body   Object
}
type Error struct {
	Status        int
	Code, TraceID string
}

func (e *Error) Error() string {
	return fmt.Sprintf("ACCP %d %s (trace %s)", e.Status, e.Code, e.TraceID)
}
func New(origin, sessionToken string) (*Client, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("ACCP origin must have no credentials, path, query or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	local := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return nil, errors.New("ACCP requires HTTPS or loopback HTTP")
	}
	if !strings.HasPrefix(sessionToken, "accp_s_") || strings.ContainsAny(sessionToken, "\r\n") {
		return nil, errors.New("a delegated ACCP Session token is required")
	}
	return &Client{origin: strings.TrimRight(origin, "/"), token: sessionToken, http: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func NewKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("secure randomness unavailable")
	}
	return hex.EncodeToString(b[:])
}

// Call does not retry automatically. After an ambiguous write, reuse the original
// key, body, version and fence; consult the current Run when a lease is uncertain.
func (c *Client) Call(ctx context.Context, method, path string, body Object, options WriteOptions) (Response, error) {
	var result Response
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\r\n#") {
		return result, errors.New("invalid API-relative path")
	}
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return result, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+"/api/v1"+path, bytes.NewReader(data))
	if err != nil {
		return result, errors.New("invalid API request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if method == "POST" {
		if len(options.IdempotencyKey) < 8 {
			return result, errors.New("a stable idempotency key is required")
		}
		req.Header.Set("Idempotency-Key", options.IdempotencyKey)
	}
	if options.Version > 0 {
		req.Header.Set("If-Match", fmt.Sprintf(`"%d"`, options.Version))
	}
	if options.FencingToken > 0 {
		req.Header.Set("X-Run-Fencing-Token", fmt.Sprint(options.FencingToken))
	}
	response, err := c.http.Do(req)
	if err != nil {
		return result, errors.New("ACCP transport failed; write outcome may be unknown")
	}
	defer response.Body.Close()
	result.Status = response.StatusCode
	result.ETag = response.Header.Get("ETag")
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
	if err != nil || len(raw) > 4*1024*1024 || json.Unmarshal(raw, &result.Body) != nil {
		return result, errors.New("invalid or oversized ACCP response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code, _ := result.Body["code"].(string)
		trace, _ := result.Body["trace_id"].(string)
		return result, &Error{Status: response.StatusCode, Code: code, TraceID: trace}
	}
	return result, nil
}
