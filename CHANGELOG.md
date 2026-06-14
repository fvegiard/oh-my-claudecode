# oh-my-claudecode v4.14.7: Team launcher, Windows tmux hardening, agent model routing

## Release Notes

Patch release with **2 new features**, **11 bug fixes**, and **2 CI/test hardening updates** across the post-`v4.14.6` dev line.

### Highlights

- **fix(team): launch single-worker prose teams and spawn cmux worker panes** (#3268 / #3267)
- **fix(tmux): strip `PSMUX_SESSION` for detached psmux creation** (#3265)
- **feat(routing): add Claude Fable 5 tier alias and model id support** (#3247 / #3246)
- **fix(hooks): honor `agents.<name>.model` for native Task/Agent calls** (#3243 / #3242)
- **fix: write refreshed OAuth tokens back to Keychain** (#3239 / #3238)

### New Features

- **feat(routing): add Claude Fable 5 tier alias and model id support** (#3247 / #3246)
- **[codex] add Cursor provider support** (#3251)

### Bug Fixes

- **fix(team): launch single-worker prose teams and spawn cmux worker panes** (#3268 / #3267)
- **fix(tmux): strip `PSMUX_SESSION` for detached psmux creation** (#3265)
- **fix(post-tool-use-failure): add `DISABLE_OMC` / `OMC_SKIP_HOOKS` skip guard** (#3255 / #3253)
- **fix(hooks): reconcile unmatched subagent fork stop events** (#3254 / #3252)
- **fix(hooks): honor `agents.<name>.model` for native Task/Agent calls** (#3243 / #3242)
- **fix(hooks): add `async:true` to SessionEnd hooks to prevent Windows shutdown cancellation** (#3241 / #3240)
- **fix: write refreshed OAuth tokens back to Keychain** (#3239 / #3238)
- **fix(wiki): create `environment.md` via dedicated reserved-safe write path** (#3237 / #3219)
- **fix(agents): make verifier agent read-only** (#3236)
- **fix(hooks): suppress verify-deliverables SubagentStop reinjection** (#3235 / #3233)
- **fix(agents): extend final-output contract to advisory agents** (#3232)

### CI / Test Hardening

- **ci(npm-pack-test): harden global tarball install against `ENOTEMPTY` rename** (#3257)
- **ci(upgrade-test): harden v4.9.3 npm install against `ENOTEMPTY` rename failure/hang** (#3256)
- **test(hud): cover z.ai Anthropic endpoint routing** (#3231)

### Docs / Metadata

- Add curated geobench profile, visibility spec, and schema follow-ups.

### Stats

- **16 PR-linked updates** | **2 new features** | **11 bug fixes** | **3 CI/test hardening updates**

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.14.7
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.14.6...v4.14.7

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo
