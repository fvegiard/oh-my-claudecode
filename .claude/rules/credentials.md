# Real authentication only

- Never invent, insert, or persist mock API keys, access tokens, or credentials
  in runtime configuration, `.env` files, Claude settings, MCP settings, or CI.
- Reuse the user's existing authenticated CLI session or an explicitly supplied
  secret. Do not overwrite credentials or switch authentication methods without
  approval.
- When a live provider needs authentication that is not available, report the
  exact missing environment variable or login step. Do not substitute a dummy
  value, claim the integration works, or print secret values.
- Synthetic credentials are allowed only in isolated tests with mocked network
  calls. Never copy test fixtures into live configuration.
- Keep secrets out of commits, logs, prompts, and screenshots. Ask the user to
  configure secrets through their local environment or GitHub environment
  secrets, never through chat.
- Cloud sessions are not the user's computer. Never copy cloud authentication,
  absolute paths, generated settings, or shell profiles into local installation
  instructions. Do not repair Linux cloud builds by installing Homebrew, Ruby,
  or changing the user's machine-wide toolchain.
