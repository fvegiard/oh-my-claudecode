# Repository development

Follow `AGENTS.md`. Use the Node.js version in `.nvmrc` and `npm ci`; do not
replace the lockfile or upgrade dependencies to resolve an environment mismatch.
This project is a CLI/Claude Code plugin, not a Netlify web application.

Never invent, insert, or persist mock API keys, access tokens, or credentials in
runtime configuration, environment files, MCP settings, or CI. Missing
authentication is a blocker for live provider calls, not permission to supply a
dummy value. Report the missing variable or login step without printing secrets.
Synthetic credentials belong only in isolated tests with mocked network calls.

Run the relevant checks before claiming success. Do not disable tests,
authorization checks, or branch protections to make checks green. See
`docs/GETTING-STARTED.md` for agent environment and authentication guidance.
Do not commit incidental `dist/` or `bridge/` changes produced by environment
setup. Generated shipping changes require the repository's explicit procedure.
