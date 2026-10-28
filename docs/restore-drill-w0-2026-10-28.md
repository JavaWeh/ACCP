# W0 restore interrupt drill (2026-10-28)

- Scale: **W0-scale seed via Stage B harness** (`scripts/prepare-w0-restore-source.mjs`) — **50** `human_users`, **200** `agent_sessions`, **25** representative `tasks` (not historical 10万-task planning language). Script `report.json` still labels `scale: "modest-drill"` because `--prepare-modest-source` was not used; **row counts are the source of truth**.
- Development login honesty: only **alice/bob** have `development_tokens` (2 rows). Extra humans are real membership rows, not 50 distinct development logins.
- Interrupted first restore: **true** (`SIGTERM` after `--interrupt-after-ms 400`); retry on **new empty** DB (no resume into partial DB)
- Snapshot: `2026-10-28T09:35:06.205946Z` · incident: `2026-10-28T09:36:36.205Z`
- Measured RPO: **89.999 s** (delivery target ≤ 3600 s) → met (**command path**)
- Measured **command** RTO: **0.580 s** wall command path **2.999 s** (delivery target ≤ 3600 s) → met
- Full **business** RTO: **not fully measured** (Stage D, 2026-10-28). Feasible single-machine subset timed at **20.128 s** (`T0` = operator start of recovery → `T_ready` after restore, ownership/grants SQL, `finish-recovery` + maintenance leave, `accp serve` as `accp_api`, `/healthz`+`/readyz`, alice development-token `/me` + tasks read + new agent session). **Residuals (do not invent passes):** empty JetStream/NATS + production Compose matrix **not run** on Windows Docker Desktop; full `accp doctor` **not OK** (needs OIDC/JetStream/worker); `accp-ops check` **residual** (table-level `UPDATE` vs `grants.sql` column `UPDATE(id,active)` — `check-privileges.sql` passed). **US-16 / D04 remains open** until production-style messaging + doctor close.
- `accp.tasks_search_trgm` after restore: **present** (backup uses `pg_dump --extension=pg_trgm` with `--schema=accp`; no DROP INDEX workaround)
- Evidence: `.accp-local/wp4-us16-restore-drill/` (local only) — retain `.age` + identity + `business-rto.jsonl` / `business-rto-summary.json`
- Stage D harness: `scripts/business-rto-wp4-us16.mjs`

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
