-- F6 GitLab provider: per-repository read-only access token, encrypted at
-- rest. The token is stored out of the repositories document jsonb so it can
-- never be echoed by the generic document-returning list/get handlers; it is
-- only read on the server when selecting a provider to verify or pull. The
-- value is authenticated AES-256-GCM ciphertext (SessionSigner.SealSecret with
-- the "repo_access_token" purpose); it is never persisted in plaintext.
ALTER TABLE repositories ADD COLUMN access_token text;
