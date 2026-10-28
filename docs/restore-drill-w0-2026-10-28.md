# W0 restore interrupt drill (2026-10-28)

- Scale: **W0-scale seed via Stage B harness** (`scripts/prepare-w0-restore-source.mjs`) — **50** `human_users`, **200** `agent_sessions`, **25** representative `tasks` (not historical 10万-task planning language). Script `report.json` still labels `scale: "modest-drill"` because `--prepare-modest-source` was not used; **row counts are the source of truth**.
- Development login: Stage B dump still ships only alice/bob `development_tokens`; **Stage G** TEST-ONLY mint (`scripts/mint-dev-tokens-wp4-us16.mjs`) adds tokens for the other 48 after restore so all **50** can log in on the restore-path development auth stack. Not OIDC; not a production bypass.
- Interrupted first restore: **true** (`SIGTERM` after `--interrupt-after-ms 400`); retry on **new empty** DB (no resume into partial DB)
- Snapshot: `2026-10-28T09:35:06.205946Z` · incident: `2026-10-28T09:36:36.205Z`
- Measured RPO: **89.999 s** (delivery target ≤ 3600 s) → met (**command path**)
- Measured **command** RTO: **0.580 s** wall command path **2.999 s** (delivery target ≤ 3600 s) → met
- Full **business** RTO: Stage D subset **20.128 s**; Stage F with empty JetStream **29.370 s**; Stage G with 50-user login sample **53.107 s** (see Stage G). Production Compose + full doctor recorded in Stage F. **US-16 / D04 remains open** (release caveat untouched; IdP/Q8 skipped).
- `accp.tasks_search_trgm` after restore: **present** (backup uses `pg_dump --extension=pg_trgm` with `--schema=accp`; no DROP INDEX workaround)
- Evidence: `.accp-local/wp4-us16-restore-drill/` (local only) — retain `.age` + identity + `business-rto.jsonl` / `business-rto-summary.json` + `stage-g/`
- Stage D/G harness: `scripts/business-rto-wp4-us16.mjs`

## Commands used

Seed (Stage B):

```powershell
node scripts/prepare-w0-restore-source.mjs `
  --isolated `
  --directory .accp-local/wp4-us16-restore-drill `
  --network accp-restore-drill `
  --app-image accp:local
```

Interrupt restore drill (Stage C — command path):

```powershell
node scripts/restore-drill-w0.mjs `
  --isolated `
  --directory .accp-local/wp4-us16-restore-drill `
  --network accp-restore-drill `
  --ops-image accp-ops:m3-local `
  --image "accp:local@sha256:b3baa7702940b2611997ac8b8aec4c061b8b033af068d7786638c9cc0c3f0626" `
  --source-database-url-file .accp-local/wp4-us16-restore-drill/source-database-url-file `
  --interrupt-after-ms 400
```

Feasible-subset business RTO (Stage D — not full production matrix):

```powershell
node scripts/business-rto-wp4-us16.mjs `
  --isolated `
  --directory .accp-local/wp4-us16-restore-drill `
  --network accp-restore-drill `
  --ops-image accp-ops:m3-local `
  --image "accp:local@sha256:b3baa7702940b2611997ac8b8aec4c061b8b033af068d7786638c9cc0c3f0626" `
  --app-image accp:local `
  --api-port 18082
```

This note records a reproducible interrupt+retry **command-path** drill at W0-scale row counts, plus an honest **partial** business-RTO subset. It does **not** declare D04 / US-16 closed.

## Stage F (2026-10-28) — production Compose + empty JetStream + doctor

Continuation authorized to clear Stage E residuals without claiming close until evidence clears.

### Production + acceptance Compose (project `accp-wp4-us16`)

- Config (local only): `.accp-local/wp4-us16-prod-compose/` via `scripts/production-env.mjs` + `scripts/oidc-fixture.mjs` + `scripts/oidc-cert.go` (existing docs path in `docs/production-deployment.md`)
- Stack: `deploy/production/compose.yaml` + `deploy/acceptance/compose.yaml`
- Image: `accp:local` (same content digest family as Stage C: `sha256:b3baa7702940b2611997ac8b8aec4c061b8b033af068d7786638c9cc0c3f0626`)
- Fresh named volumes including **empty** `accp-wp4-us16_nats-data` (JetStream store empty at first start)
- Bootstrap: 1 human / 1 project (OIDC fixture admin subject)
- IdP/Q8 multi-user drill: **skipped** (as authorized); Keycloak fixture used only so `accp doctor` OIDC checks can run

Full `accp doctor --json` on that stack:

```json
{"ok":true,"checks":[{"name":"configuration","ok":true},{"name":"execution_configuration","ok":true},{"name":"oidc_discovery","ok":true},{"name":"oidc_jwks","ok":true},{"name":"database","ok":true},{"name":"migrations","ok":true},{"name":"worker_progress","ok":true},{"name":"runtime_privileges","ok":true},{"name":"worker_configuration","ok":true},{"name":"public_tls_and_api","ok":true},{"name":"jetstream","ok":true}]}
```

Evidence: `.accp-local/wp4-us16-restore-drill/stage-f/doctor-prod-compose.json`

### `accp-ops check` vs `grants.sql`

- Root cause: `CheckGrants` used table-level `has_table_privilege(... UPDATE)` while `grants.sql` / `check-privileges.sql` intentionally grant/assert column `UPDATE(human_users.active)`.
- Fix: `internal/recovery/grants.go` now uses `has_column_privilege` for that ACL (mirrors v1.0.1 contract). Ops image rebuilt as `accp-ops:m3-local` (`sha256:0638710148582e10f9fd41125f4d89ea1ec1778662770a2791cb571cc9e1a273`).
- Prod compose migrator URL: `{"check":"grants","ok":true}`
- Restore-path re-check: `ops_check_status: 0` with privilege probe `false,true,true` (table UPDATE false, column active UPDATE true, task_contexts DELETE true)

### Restore / business RTO with empty JetStream

```powershell
node scripts/business-rto-wp4-us16.mjs `
  --isolated `
  --directory .accp-local/wp4-us16-restore-drill `
  --network accp-restore-drill `
  --ops-image accp-ops:m3-local `
  --image "accp:local@sha256:b3baa7702940b2611997ac8b8aec4c061b8b033af068d7786638c9cc0c3f0626" `
  --app-image accp:local `
  --api-port 18082 `
  --with-empty-jetstream
```

| Metric | Stage F value |
|---|---|
| Drill id (Stage C backup) | `5b18d57b-314c-4692-a6eb-124133686799` |
| Command RPO (restore report) | 89.999 s |
| Business RTO (`T0`→`T_ready`) | **29.370 s** (≤ 3600 s) |
| Empty JetStream gate | **pass** (fresh volume + `configs/nats.conf`) |
| Worker on restore path | started; doctor `worker_progress` + `jetstream` **true** |
| `accp-ops check` | **pass** |
| Restore-path `accp doctor` | **not ok** — expected: `production_oidc` + `public_tls_and_api` false under development auth W0 seed |
| Full production doctor | **ok** on Compose project above |

### Still residual after Stage F (superseded in part by Stage G)

1. **48 extra development logins** — cleared in Stage G via TEST-ONLY mint (see below).
2. **`docs/releases/` WP-4 caveat** — intentionally untouched (no release-caveat removal in this stage).
3. Restore-path doctor is not a substitute for the production Compose doctor (already recorded separately).

**Verdict (Stage F):** Stage F cleared production Compose + empty JetStream + full doctor + ops-check mismatch. Login residual deferred to Stage G.

## Stage G (2026-10-28) — 50-user post-restore login sample + business RTO

Continuation to clear the alice/bob-only login residual without changing server auth or release notes. IdP/Q8 multi-user drill stays **skipped**.

### Why not Keycloak / OIDC for the 50 W0 humans

- Restored humans use issuer `urn:accp:development` (Stage B seed via management API).
- Acceptance Keycloak realm (`accp-wp4-us16`) is a separate OIDC issuer with 3 fixture users; client has `directAccessGrantsEnabled: false` (no password-grant token mint).
- Remapping issuers or enabling a production auth bypass was rejected. Prod compose project **left running** and untouched for OIDC/TLS doctor evidence from Stage F.

### TEST-ONLY mint (scripts only)

```powershell
# Invoked by business-rto harness after restore + serve (also runnable alone):
node scripts/mint-dev-tokens-wp4-us16.mjs --isolated `
  --pg-container <restored-pg> --database accp_restore `
  --retained-users .accp-local/wp4-us16-restore-drill/source-users.json `
  --output .accp-local/wp4-us16-restore-drill/stage-g/minted-users.json `
  --report .accp-local/wp4-us16-restore-drill/stage-g/mint-report.json

node scripts/login-sample-probe-wp4-us16.mjs --isolated `
  --origin http://127.0.0.1:18082 `
  --users .accp-local/wp4-us16-restore-drill/stage-g/minted-users.json `
  --report .accp-local/wp4-us16-restore-drill/stage-g/login-probe.json
```

| Mint metric | Value |
|---|---|
| Development humans | **50** |
| Reused retained (alice/bob) | **2** |
| Newly minted | **48** |
| `development_tokens` rows after | **50** |
| Secrets location | `.accp-local/.../stage-g/minted-users.json` only (untracked; never printed) |

### Login sample probe (each of 50)

For every credential: `GET /api/v1/me`, list `project_demo` tasks, create agent + new session.

| Probe metric | Value |
|---|---|
| Probed | **50** |
| `/me` pass | **50** |
| Tasks list pass | **50** |
| New session pass | **50** |
| Full pass (all three) | **50 / 50** |

Evidence: `.accp-local/wp4-us16-restore-drill/stage-g/login-probe.json` (counts + per-user statuses; no tokens)

### Business RTO re-run (empty JetStream + full login sample)

```powershell
node scripts/business-rto-wp4-us16.mjs `
  --isolated `
  --directory .accp-local/wp4-us16-restore-drill `
  --network accp-restore-drill `
  --ops-image accp-ops:m3-local `
  --image "accp:local@sha256:b3baa7702940b2611997ac8b8aec4c061b8b033af068d7786638c9cc0c3f0626" `
  --app-image accp:local `
  --api-port 18082 `
  --with-empty-jetstream
```

| Metric | Stage G value |
|---|---|
| Drill id (Stage C backup) | `5b18d57b-314c-4692-a6eb-124133686799` |
| Run id | `431612a4-e707-4832-9ca5-3b721fb33ffe` |
| Command RPO (restore report) | 89.999 s |
| Business RTO (`T0`→`T_ready`) | **53.107 s** (≤ 3600 s) |
| vs Stage F (alice-only probe) | 29.370 s → 53.107 s (mint + 50× login sample included) |
| Empty JetStream gate | **pass** |
| Login sample gate | **pass** (50/50) |
| `accp-ops check` | **pass** |
| Restore-path `accp doctor` | **residual** (expected under development auth) |
| Prod compose `accp-wp4-us16` | **kept up** (unchanged) |
| IdP/Q8 | **skipped** (authorized) |

### Still residual (do not claim D04 / US-16 closed)

1. **`docs/releases/` WP-4 caveat** — intentionally untouched; no authority to remove in this stage.
2. **IdP/Q8 target drill** — intentionally skipped (not executed; not claimed).
3. Restore-path doctor under development auth is not the production Compose doctor (Stage F already recorded `ok:true` separately).

**Verdict:** Stage G cleared the 48-human development-login residual with a TEST-ONLY post-restore mint + 50/50 probe on the restore-path stack. Business RTO with fuller login sample is **53.107 s**. **US-16 / D04 still cannot be declared closed** while the release caveat remains and IdP/Q8 stays skipped.
