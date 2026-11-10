# fvegiard fork of oh-my-claudecode

Upstream: https://github.com/Yeachan-Heo/oh-my-claudecode. This fork is what Frank's machines install.

## Branches
| Branch | What it holds | Who moves it |
|--------|---------------|--------------|
| `main` | Exact mirror of upstream `main`, fast-forward only, never committed to (commit to a `fork/*` or `fix/*` branch for `dev` instead) | `gh repo sync fvegiard/oh-my-claudecode -b main` |
| `dev` | `main` plus this fork's changes; every change lands here by PR, upstream CI (`CI`, `Upgrade Test`) runs on it | PRs from `fork/*` or `fix/*` branches; merge `main` into it after each sync |
| `stable` | What the machines install: `claude plugin marketplace add "https://github.com/fvegiard/oh-my-claudecode.git#stable"` | PR `dev` → `stable` once the 5-day rule below is met. `CI` and `Upgrade Test` do not trigger on `stable` (their push and PR filters are `[main, dev]`), so the gate is the `dev` runs of those 5 days (`gh run list -R fvegiard/oh-my-claudecode -b dev -w CI -L 20`, same with `-w "Upgrade Test"`), not a check on that PR |

## The 5-day rule
Nothing goes upstream (no PR, issue patch or push to Yeachan-Heo/oh-my-claudecode) and nothing is promoted to
`stable` until `dev` has been green for 5 consecutive days; until then the change stays on `dev`. Green is measured
against upstream: CI and Upgrade Test on `dev` fail no test that upstream's own CI passes on the same upstream commit
(upstream is sometimes red itself), and on the machine `omc doctor conflicts` is clean with the plugin enabled. A day
with a fork-only failure restarts the count.

`Generated Artifact Authorization` (job `Authorize generated artifacts from base trust root`) is outside green: it
fails on every PR in this fork whatever the diff (PRs #1 and #2 changed only this file), because
`scripts/verify-generated-artifact-authorization.mjs` hardcodes `OWNER = 'Yeachan-Heo'` and upstream's owner-signed
manifest. No upstream run exists to compare it with.

## Syncing with upstream
1. `gh repo sync fvegiard/oh-my-claudecode -b main`, then `git fetch --all` and check that
   `git rev-parse origin/main upstream/main` prints one SHA twice.
2. Branch `fork/sync-upstream-<version>` from `origin/dev` and `git merge upstream/main`. On a conflict in a file
   listed under "Fork-only changes", apply that row's "Drop when" column.
3. `bun install --frozen-lockfile --ignore-scripts --dry-run` must exit 0. Claude Code runs that install on
   `claude plugin update`; when it fails the new plugin cache gets no `node_modules`. If it fails:
   `bun install --ignore-scripts --lockfile-only`, commit `bun.lock`, add or keep its row below.
4. As the last commit of the branch, after `npm ci`:
   `ISSUE_3702_HEAD=$(git merge-base HEAD origin/dev) node scripts/generate-inventory-graph.mjs --write`, then
   `node scripts/generate-inventory-graph.mjs --verify` must exit 0. The baseline hashes tracked files, so fork-only
   files (this one included) fail `tests/lint/inventory-graph-drift.test.ts` without it.
5. PR to `dev`. A failing test counts against green only if upstream's CI passes it on the merged upstream commit.

## Fork-only changes on `dev`
Every sync keeps each row until its "Drop when" is true. A change missing from this table is not protected.

| Change | Why | Drop when |
|--------|-----|-----------|
| `FORK.md` | This policy | Never |
| `bun.lock` regenerated at the v5.8.3 sync (2026-11-09) | Upstream v5.8.3 moved `tsx` to `dependencies` and added `fast-check` in `package.json` without updating `bun.lock`, so step 3 fails on upstream's file | Upstream's own `bun.lock` passes step 3: take upstream's file |
| `inventory/inventory-graph.json` regenerated | Covers the fork-only files (step 4) | Never: on conflict take upstream's file, then redo step 4 |
| Exa MCP server off without a key: `src/config/loader.ts`, `src/mcp/servers.ts` and their tests | Upstream defaults `mcpServers.exa.enabled` to `true` and starts the server with no key, which can only fail. Here a key (`EXA_API_KEY` or a config-file `apiKey`) enables it and a config-file `enabled: false` wins | Upstream gates Exa on a key itself |
| `omc config` redaction: `src/cli/config-display.ts`, `src/cli/index.ts` and its test | Upstream prints the loaded config unredacted. Here sensitive values are redacted and missing credentials are warned about | Upstream redacts `omc config` output itself |
| `.github/workflows/pr-check.yml`: `pull-requests: write` on the `size-check` job only | Upstream grants it to the whole workflow | Upstream scopes it to the job |
| `.secret-scan-allowlist` | Hash-keyed reviewed exceptions for machine-setup's `scripts/secret-scan` (format in machine-setup `docs/secret-scan.md`) | An entry's matched bytes change: re-review that entry, never widen it |
| Docs: `agents/explore.md` (no `explore-high`, which does not exist), `skills/ask/SKILL.md` and `docs/REFERENCE.md` (advisor CLIs do not inherit Claude Code's GitHub MCP tools) | Upstream text points at a missing agent and is silent on the MCP limit | Upstream says the same |

## After promoting `stable`
On each machine, and again inside each `claude-env <name>` (it has its own plugin and clone), in this order:
1. `claude plugin update oh-my-claudecode@omc`
2. `git -C ~/.local/share/omc/src fetch origin && git -C ~/.local/share/omc/src checkout --detach origin/stable`
3. `omc-sync-check` prints `omc in sync`
4. `omc setup`, then `omc doctor conflicts` is clean; restart Claude Code

## Local clones
Pushes go to `origin` (the fork). The `upstream` remote's push URL is set to `DISABLED-no-push-to-upstream`, so an
accidental push to upstream fails: `git remote set-url --push upstream DISABLED-no-push-to-upstream`. Check with
`git remote -v`.
