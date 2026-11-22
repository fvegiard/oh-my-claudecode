# fvegiard fork of oh-my-claudecode

Upstream: https://github.com/Yeachan-Heo/oh-my-claudecode. This fork holds Frank's own changes. The machine (checked 2026-11-22) installs the upstream plugin directly from upstream `main` (marketplace `omc`, auto-update on), not from this fork.

## Branches
| Branch | What it holds | Who moves it |
|--------|---------------|--------------|
| `main` | Exact mirror of upstream `main`, fast-forward only, never committed to (commit to a `fork/*` or `fix/*` branch for `dev` instead) | `gh repo sync fvegiard/oh-my-claudecode -b main` |
| `dev` | `main` plus this fork's changes; every change lands here by PR, upstream CI (`CI`, `Upgrade Test`) runs on it | PRs from `fork/*` or `fix/*` branches; merge `main` into it after each sync |
| `stable` | The fork's promotion branch. Machines no longer install it (checked 2026-11-22: plugin marketplace `omc` follows `https://github.com/Yeachan-Heo/oh-my-claudecode.git#main`, auto-update on, per `~/.claude/plugins/known_marketplaces.json`); `origin/stable` last moved at v5.7.31 (2026-11-03) | PR `dev` → `stable` once the 5-day rule below is met |

## The 5-day rule
Nothing goes upstream (no PR, issue patch or push to Yeachan-Heo/oh-my-claudecode) and nothing is promoted to
`stable` until `dev` has been green for 5 consecutive days; until then the change stays on `dev`. Green is measured
against upstream: CI and Upgrade Test on `dev` fail no test that upstream's own CI passes on the same upstream commit
(upstream is sometimes red itself), and on the machine `omc doctor conflicts` is clean with the plugin enabled. A day
with a fork-only failure restarts the count.

## Local clones
Pushes go to `origin` (the fork). The `upstream` remote's push URL is set to `DISABLED-no-push-to-upstream`, so an
accidental push to upstream fails: `git remote set-url --push upstream DISABLED-no-push-to-upstream`. Check with
`git remote -v`.
