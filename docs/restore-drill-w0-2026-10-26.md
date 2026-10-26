# W0 restore interrupt drill (2026-10-26)

- Scale: **modest drill** (bootstrap demo seed in `accp` schema; not a full 50-user seed)
- Interrupted first restore: **true**; retry on **new empty** DB (no resume into partial DB)
- Snapshot: `2026-10-26T08:01:42.752235Z` · incident: `2026-10-26T08:03:12.752Z`
- Measured RPO: **90.000 s** (delivery target ≤ 3600 s) → met
- Measured command RTO: **0.586 s** (delivery target ≤ 3600 s) → met
- Full business RTO: **not measured** (includes human check, grants/ownership, redeploy — see [operations.md](operations.md))
- `accp.tasks_search_trgm` after restore: **present** (backup uses `pg_dump --extension=pg_trgm` with `--schema=accp`; no DROP INDEX workaround)
- Evidence: `.accp-local/m3-restore-drill/` (local only)

This note records a reproducible interrupt+retry drill. It does not declare D04 / US-16 closed at full W0 data volume.
