# Next-Phase Plan

Prepared 2026-10-20. Grounded in the current `main` tree (HEAD `8c148a0`, merge of PR #21 "D07 task lifecycle and D09 Git contexts") and the project's own gap-tracking docs. GitHub shows 0 open issues / 0 open PRs, so this plan is the first structured backlog since D07/D09 landed.

This document does not repeat the full Chinese-language gap analysis in [docs/product-delivery-plan.md](product-delivery-plan.md); it re-reads that plan against the code as it stands today, marks what PR #21 closed, and reprioritizes what is left.

## 1. Current state summary

**Purpose.** ACCP (Agent Collaboration Control Plane) is a self-hosted control plane that lets human teams and heterogeneous AI coding agents collaborate on tasks with human-owned acceptance. It explicitly does not provide model inference and does not use chat history as its orchestration database (docs/architecture.md:7).

**Stack.** Go 1.27.1 backend on `net/http` (go.mod), PostgreSQL 17 via pgx (internal/database), NATS JetStream for the event bus (internal/eventbus), OIDC via go-oidc/go-jose (internal/auth), MCP Go SDK for the tool gateway (internal/gateway), age for backup encryption (internal/recovery). Frontend is React 19.3 + TypeScript 7 + Vite 8 + HeroUI/Tailwind in `web/`, i18n in zh-CN/en-US/ru-RU (web/src/locales).

**Module layout** (internal/, `.go` files / `_test.go` files):

- `controlplane` — 43 files, by far the largest module: task lifecycle, context/artifact registries, governance, sessions, management, gateway HTTP surface. Largest files: internal/controlplane/server.go (437 lines), internal/controlplane/tasks_execution.go (467 lines), internal/controlplane/management.go (338 lines), internal/controlplane/governance_worker.go (316 lines).
- `config` — 7 files; `auth` — 6; `recovery` — 5; `bridge` — 4; `database` — 4; `gitprovider` — 4; `bootstrap` — 2; `gateway` — 2; `eventbus` — 1; `observability` — 1.
- `cmd/accp`, `cmd/accp-bridge`, `cmd/accp-ops` are the three binaries; `pkg/client` is the Go collaboration SDK.

**Frontend shape.** `web/src` is flat rather than component-tree structured: web/src/workspace.tsx (1527 lines), web/src/main.tsx (1087 lines), web/src/tasks.tsx (1042 lines) are large monolithic files; web/src/operations.tsx (331), web/src/management.tsx (257), web/src/ui.tsx (420) are smaller. No subdirectory decomposition by feature or component exists yet.

**Test coverage.** 36 Go `_test.go` files out of 89 total `.go` files (repo-wide), concentrated in `internal/controlplane` (many `*_integration_test.go` files requiring Postgres/NATS, e.g. internal/controlplane/product_d07_d09_integration_test.go, internal/controlplane/recovery_integration_test.go). Web has 5 Playwright spec files (web/tests/console.spec.ts, diff.spec.ts, oidc.spec.ts, oidc-lifecycle.spec.ts, ui.spec.ts) plus a contracts corpus under `contracts/examples/{valid,invalid}` validated by `npm run check`. No TODO/FIXME/XXX/HACK markers were found anywhere in `.go`/`.ts`/`.tsx` sources — the team tracks debt in prose docs, not code comments.

**CI.** Four GitHub Actions workflows, all gating `main` and PRs:

- .github/workflows/control-plane.yml — Go fmt/vet, `go test -race -tags=integration` against real Postgres+NATS containers, binary builds, Docker image build.
- .github/workflows/console.yml — web type-check/build, Playwright component + accessibility (axe-core) regression, then a full browser acceptance run against a real compose stack.
- .github/workflows/production-foundation.yml — the heaviest job (30 min budget): builds a disposable OIDC/TLS environment, runs bootstrap, least-privilege DB checks (deploy/production/check-privileges.sql), real PKCE browser login, worker-failure/recovery drill, and live secret-rotation and signing-key-rotation drills.
- .github/workflows/validate.yml — docs/contracts/private-path checks via `npm run check`.

**Docs/roadmap state.** The repo tracks its own roadmap unusually explicitly:

- docs/product-delivery-plan.md is a dated (2026-09-17, with a 2026-09-29 update layered in via docs/d07-d09.md) gap analysis enumerating D01–D10 with P0/P1 priorities, a W0–W9 work-package breakdown, and explicit "formal delivery gate" criteria. It states D07/D08 and D09 implementation as done as of this plan's writing, with D06 and D10 still "待实施" (not started).
- docs/d07-d09.md (2026-09-29, branch `javaweh/product-d07-d09`, the branch merged in PR #21) documents what actually shipped: constrained task edit/handoff/archive (D07) and GitHub-commit-pinned text context sync with diff review (D09). It explicitly flags unresolved items: a full `go test -race -tags=integration` run was interrupted by a local Docker disconnect and not completed; live GitHub API reads hit anonymous 403 rate limits and still need verification against a target environment with `ACCP_GITHUB_TOKEN`; a new DB grant (`deploy/production/grants.sql`) must be re-applied on upgrade.
- docs/mvp.md, docs/governance.md, docs/architecture.md, docs/reliability.md define scope boundaries (single-org, single-machine, 256 KiB text/Git-reference-only content, no object storage) and an explicit non-MVP list (multi-tenant SaaS, billing, centralized runners, Kubernetes, multi-region).
- docs/acceptance-2026-09-16.md and docs/acceptance-product-operations.md are dated acceptance records (single-operator, two-client Claude Desktop/Codex CLI exercise; D03–D05 operational drills with measured RPO ≈71.9s on a small sample) — explicitly not scaled or multi-person validation.
- 9 ADRs (docs/adr/0001…0009) record accepted design decisions; the README notes ADR "accepted" means the design baseline is chosen, not that runtime behavior is proven.

**Known capacity risk, already called out in docs but now independently confirmed in code:** internal/database/database.go:25 hardcodes `cfg.MaxConns = 10`, and internal/eventbus/worker.go:101 takes a single Postgres advisory lock (`pg_try_advisory_xact_lock`) around the whole delivery loop, serializing event dispatch globally. docs/product-delivery-plan.md:80 (D06) already flags this as a capacity concern pending load testing, not a proven defect.

**Code quality signal.** No TODO/FIXME debt markers, CI enforces `gofmt`, `go vet`, race-detector integration tests, and real browser/OIDC acceptance on every push — unusually rigorous for a project of this size. The debt that does exist is tracked candidly in docs (product-delivery-plan.md's gap table) rather than hidden.

## 2. Next-phase goals

Goals are reframed from docs/product-delivery-plan.md's own "formal delivery gate" (§ "正式交付门槛") now that D07/D09 are merged:

1. **Close the two P0 gaps the delivery plan still marks open that aren't infrastructure-ordering dependent**: D06 (capacity validation under a frozen load target) and D10 (versioned release artifacts — images, Bridge packages, upgrade notes). These are the only P0 items without a stated hard dependency on acquiring a target enterprise's IdP/Git/MCP environment.
2. **Verify, don't re-plan, D09's two self-reported unresolved items** (interrupted race+integration run; unauthenticated GitHub 403 against real token) — these are quick, bounded verification tasks against work already merged, not new design.
3. **Reduce the two concrete code-level capacity risks** (10-connection pool ceiling, single global advisory-lock event loop) with an actual load test before deciding whether to redesign — per the project's own stated principle in product-delivery-plan.md:86 ("数据库行锁、单条事件循环是容量风险线索，不能代替压测结论").
4. **Begin the identity/deployment track (W1/W4 in product-delivery-plan.md)** only after W0 (freezing target scale, SLOs, supported environments) is explicitly done — the plan itself orders W0 first for a reason: every downstream estimate depends on it.
5. **Do not scope-creep**: multi-tenant SaaS, object storage, centralized runners, and Kubernetes remain explicitly out of scope per docs/mvp.md's non-MVP list; this plan does not revisit that boundary.

## 3. Prioritized backlog

### P0 — blocks a release candidate

| # | Item | Rationale | References |
| --- | --- | --- | --- |
| P0-1 | Freeze target scale/SLOs (W0) before any capacity work | product-delivery-plan.md's own ordering puts this first because every later estimate (pool sizing, lock contention tolerance, backup cadence) depends on it; skipping it risks redoing W6 work | docs/product-delivery-plan.md:94 (W0 row), docs/mvp.md:71 (non-MVP boundary to hold the line on) |
| P0-2 | Load-test the two capacity choke points under the frozen target from P0-1: the 10-connection pgx pool and the single global advisory-lock event-delivery loop | These are verified in code, not just docs: `cfg.MaxConns = 10` is a hard ceiling shared by API+Worker+migrations, and the advisory lock makes event dispatch single-threaded per process; under load this could show up as request queuing or event-visibility lag before any other symptom | internal/database/database.go:25, internal/eventbus/worker.go:101, docs/product-delivery-plan.md:80 (D06) |
| P0-3 | Finish the two D09 verification items the implementers explicitly left open | These are not new work — d07-d09.md itself lists them as "不计为通过" (not counted as passed): a full `go test -race -tags=integration -count=1 ./...` run that was interrupted by a local Docker disconnect, and GitHub content sync that was only tested unauthenticated (403 rate-limited) and needs a real `ACCP_GITHUB_TOKEN` run against a target repo | docs/d07-d09.md:23 |
| P0-4 | Re-apply/verify `deploy/production/grants.sql` on any environment that deployed before D09, since it now grants API a targeted DELETE on `task_contexts` | Documented as a required but easy-to-miss upgrade step; skipping it silently breaks "editable task re-select context" (D07) in upgraded environments | docs/d07-d09.md:25 |
| P0-5 | Define and ship versioned release artifacts: tagged/digest-pinned container images, a distributable Bridge package, and an upgrade/compatibility note (D10) | CI builds images and binaries on every push (`.github/workflows/control-plane.yml`) but there is no tagging/publishing workflow; "buildable" is explicitly called out as not the same as "installable/supportable" in the project's own plan | .github/workflows/control-plane.yml:55-63 (build steps, no publish step), docs/product-delivery-plan.md:84 (D10 row), docs/product-delivery-plan.md:102 (W8) |

### P1 — required for the first sustainable-use milestone, not release-blocking by itself

| # | Item | Rationale | References |
| --- | --- | --- | --- |
| P1-1 | Decompose the three largest web files (workspace.tsx, main.tsx, tasks.tsx — together ~3,650 of ~5,100 total lines in web/src) along feature/component lines | All UI logic for tasks, workspace, and app bootstrap currently lives in three monolithic files with no subdirectory structure under web/src; this is a maintainability risk independent of any functional gap, and will only get harder to untangle as D08-adjacent work (pagination, deep links) adds more surface to these same files | web/src/workspace.tsx (1527 lines), web/src/main.tsx (1087 lines), web/src/tasks.tsx (1042 lines) |
| P1-2 | Production identity hardening (W1/D02): keep SPA client ID (`accp-web` / `ACCP_OIDC_CLIENT_ID`) distinct from API audience (`accp-api` / `ACCP_OIDC_AUDIENCE`) in ops docs (US-17); real-IdP key-rotation/expiry drills beyond the isolated CI fixture remain deferred this phase (Q8) | Code and ADR 0008 already separate SPA client ID from API audience and reject ID/opaque tokens as API bearers. Remaining doc-wording drift is closed by US-17. Target-IdP rotation/expiry scenarios stay "待演练" despite the disposable Keycloak fixture in production-foundation.yml | docs/product-delivery-plan.md (D02), docs/production-deployment.md, .github/workflows/production-foundation.yml:65-71 |
| P1-3 | Enterprise continuous management (W2/D01): support adding/deactivating members, creating/archiving projects, and registering repositories on an *already-bootstrapped* instance, not just at first install | internal/bootstrap/bootstrap.go only supports bootstrapping an empty database per the project's own gap note; day-2 operations currently require direct DB writes | docs/product-delivery-plan.md:75 (D01 row) |
| P1-4 | Daily-use console ergonomics (W3/D08): server-side filter/sort with real pagination instead of full-collection polling, stable deep links, idempotent retry on timeout | web/src/api.ts fetches full collections page-by-page and the main UI polls multiple collections every 10 seconds; this is already flagged as a scaling concern in the plan, and is now also harder to fix cleanly without first doing P1-1's decomposition | docs/product-delivery-plan.md:82 (D08 row), web/src/api.ts |
| P1-5 | Recovery/observability completion (W5/D04-D05): full-scale backup/restore drill, restore-interruption handling, and end-to-end business RTO measurement | The 2026-09-17 drill in docs/acceptance-product-operations.md explicitly reports a small-sample RPO of 71.878s and states full-scale, restore-interruption, and full business RTO are still owed before a release candidate | docs/acceptance-product-operations.md:40-42 |

### P2 — valuable but not required for the next milestone

| # | Item | Rationale | References |
| --- | --- | --- | --- |
| P2-1 | Resolve docs/product-delivery-plan.md's own internal staleness: it carries both a 2026-09-16 "pre-coding assessment" section and a later D01-D10 status section in the same file, which is easy to misread as current | The file itself warns readers not to treat the historical section as current ("避免把历史完成状态当作成品放行结论") but the structure still invites confusion for a new reader | docs/product-delivery-plan.md:132-142 |
| P2-2 | Expand automated test coverage ratio in `internal/controlplane` (43 source files, ~20 test files visible) now that D07/D09 added several new integration tests, to keep pace with the module's continued growth | `controlplane` is both the largest module and the one accumulating the most new surface area (task lifecycle, git contexts); without deliberate attention its test-to-source ratio will keep diluting | internal/controlplane (43 `.go` files per repo scan) |
| P2-3 | Investigate Windows Playwright process-exit cleanup issue noted across multiple acceptance records | Flagged repeatedly (docs/product-delivery-plan.md, acceptance docs) as "not counted as a passing command" even when all 14 UI cases reported success; low severity but recurring enough to warrant a root-cause pass instead of continuing to caveat it in every acceptance record | docs/product-delivery-plan.md:36, docs/acceptance-product-operations.md:14 |
| P2-4 | Evaluate bundle size (main JS chunk ~815 KB / ~241 KB gzip per the plan's own build output note) once P1-1's decomposition lands, since code-splitting is far easier after the monolith files are broken up | The plan already flags this as "an optimization lead, not a measured performance result" — worth revisiting only after structural decomposition, not before | docs/product-delivery-plan.md:138 |

## 4. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Capacity work (P0-2) starts before W0 scale targets are frozen, producing tuning that doesn't match the real target and has to be redone | Wasted engineering time; possible premature architecture changes (e.g., splitting the advisory lock) based on an assumed load profile | Sequence strictly: P0-1 before P0-2, matching the project's own stated ordering in product-delivery-plan.md's work-package table |
| The two D09 "not counted as passed" items (P0-3) are treated as closed because the feature itself shipped in PR #21 | A silent regression or an unauthenticated-only code path ships to a target environment with a real GitHub token and behaves differently than tested | Explicitly re-open them as tracked follow-up issues referencing docs/d07-d09.md:23 rather than letting the PR merge imply they're resolved |
| Frontend decomposition (P1-1) is deferred indefinitely because it has no external-facing symptom | The three monolithic files keep growing as D08 and future work adds to them, making a later refactor progressively more expensive and risky | Schedule P1-1 before, or in lockstep with, P1-4 (D08 ergonomics work), since both touch the same files |
| Release-artifact work (P0-5) is treated as "just add a tag" | Without a defined compatibility/upgrade-note process, an early tagged release could ship without the grants.sql-style upgrade steps (see P0-4) being captured, repeating the D09 upgrade-gap pattern | Make "upgrade notes reviewed against the last 3 merged feature branches' docs" a checklist item in the D10 release workflow definition |
| This plan's own backlog goes stale the way product-delivery-plan.md warns about itself | A future reader treats this document as current without checking git log / merged PRs since 2026-10-20 | Keep this document's P0/P1 items linked to their underlying source docs (not restated facts) so staleness is visible by diffing against those docs, not by re-deriving from scratch |

## 5. Open questions

1. Has W0 (target scale, SLOs, supported environment matrix) actually been frozen anywhere outside this analysis? docs/product-delivery-plan.md treats it as a prerequisite but no dated "W0 complete" record exists in docs/ as of this writing.
2. Does the target deployment environment for the next pilot already have a real `ACCP_GITHUB_TOKEN` and a test repository available, or does P0-3's GitHub-auth verification block on external account provisioning (as docs/d07-d09.md implies)?
3. Is there an existing GitHub Issue/milestone tracking D06 and D10 specifically, given GitHub currently shows 0 open issues? If not, should this backlog be filed as issues before work starts, per CONTRIBUTING.md's guidance that non-trivial work should go through an Issue aligned with the delivery plan?
4. Who owns the decision to re-scope P1-1 (frontend decomposition) as a prerequisite for P1-4 (D08 ergonomics) versus running them in parallel with merge-conflict risk?
5. Is there a maintained CI job (or planned one) that actually publishes the images/packages from P0-5, or does "release" mean something more manual (e.g., tagging a commit and pointing operators at `docker build`) for the first version?
