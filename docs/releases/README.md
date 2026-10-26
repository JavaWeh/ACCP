# Release upgrade notes

Each published tag `v*` must have a matching file `docs/releases/<tag>.md` before the release workflow may push GHCR images or create a GitHub Release. The checker is a **CI gate** (US-8): incomplete notes fail the pipeline closed.

## Required sections

Every `docs/releases/v*.md` file must include:

1. A level-1 title equal to the git tag (for example `# v0.1.0-rc.1`).
2. `## Compatibility` — supported upgrade-from versions, or “fresh install only”.
3. `## Migrations` — SQL/migrate steps, or explicit “none”.
4. `## Grants / privileges` — must mention `deploy/production/grants.sql` **and** verification with `accp-ops check` (or the compose `grants` service and the documented fix command).
5. `## Config / secrets / compose` — env or secret file changes, or “none”.
6. `## Breaking / operator actions` — anything that can silently break operators (for example missing grants after D09).
7. `## Reviewed-against` — at least three bullets naming real in-repo paths reviewed for this release (typically recent feature docs on `main`).
8. `## Artifacts` — may say digests/checksums live on the GitHub Release; must not leave upgrade content empty elsewhere.

## Local check

```sh
node scripts/check-upgrade-notes.mjs
node scripts/check-upgrade-notes.mjs --version v0.1.0-rc.1
npm run check
```

The release workflow runs the versioned form against the pushed tag before any GHCR push or Release create. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for how to cut a tag.
