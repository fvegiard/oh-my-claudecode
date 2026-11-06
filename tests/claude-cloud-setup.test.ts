import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'omc-cloud-setup-'));
  fixtures.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, '.claude'));
  copyFileSync(join(root, 'scripts/claude-cloud-setup.sh'), join(dir, 'scripts/setup.sh'));
  writeFileSync(join(dir, '.nvmrc'), '24\n');
  writeFileSync(join(dir, '.claude/settings.json'), '{"env":{"EXISTING":"preserved"}}\n');
  writeFileSync(join(dir, 'environment'), '');
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo "\${MOCK_NODE_MAJOR:-24}"
elif [ "$1" = "--version" ]; then echo v24.0.0
else cat >/dev/null; echo sqlite >> "$SETUP_LOG"
fi
`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
echo "$*" >> "$SETUP_LOG"
exit "\${MOCK_NPM_EXIT:-0}"
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: dir,
    NVM_DIR: join(dir, 'nvm'),
    CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_ENV_FILE: join(dir, 'environment'),
    SETUP_LOG: join(dir, 'commands'),
    MOCK_NODE_MAJOR: '24',
    MOCK_NPM_EXIT: '0',
  };
  return {
    dir,
    env,
    run: (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync('bash', [join(dir, 'scripts/setup.sh')], {
        env: { ...env, ...overrides },
        encoding: 'utf8',
      }),
  };
}

describe.skipIf(process.platform === 'win32')('Claude cloud setup isolation', () => {
  it('does nothing outside Claude cloud, including on a local startup', () => {
    const f = fixture();
    const result = f.run({ CLAUDE_CODE_REMOTE: '' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8')).toBe('');
    expect(() => readFileSync(f.env.SETUP_LOG)).toThrow();
  });

  it('installs locked dependencies, verifies SQLite, and builds without rewriting settings', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.env.SETUP_LOG, 'utf8').trim().split('\n')).toEqual([
      'ci --no-audit --no-fund', 'sqlite', 'run build',
    ]);
    expect(readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8')).toContain('export PATH=');
    expect(readFileSync(join(f.dir, '.claude/settings.json'), 'utf8')).toBe(
      '{"env":{"EXISTING":"preserved"}}\n',
    );
    expect(result.stdout).toContain('No credentials or global Claude settings were changed.');
  });

  it('fails explicitly when the cloud runtime is wrong and nvm is unavailable', () => {
    const f = fixture();
    const result = f.run({ MOCK_NODE_MAJOR: '22' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires Node.js 24 or nvm');
    expect(() => readFileSync(f.env.SETUP_LOG)).toThrow();
  });

  it('selects the pinned runtime through existing nvm', () => {
    const f = fixture();
    mkdirSync(f.env.NVM_DIR);
    writeFileSync(join(f.env.NVM_DIR, 'nvm.sh'), `nvm() {
echo "nvm $*" >> "$SETUP_LOG"
export MOCK_NODE_MAJOR=24
}
`);
    const result = f.run({ MOCK_NODE_MAJOR: '22' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.env.SETUP_LOG, 'utf8')).toMatch(/^nvm install 24\nnvm use 24\n/);
  });

  it('does not claim success or build when dependency installation fails', () => {
    const f = fixture();
    const result = f.run({ MOCK_NPM_EXIT: '7' });
    expect(result.status).toBe(7);
    expect(readFileSync(f.env.SETUP_LOG, 'utf8')).toBe('ci --no-audit --no-fund\n');
    expect(result.stdout).not.toContain('setup complete');
  });
});

it('registers cloud setup only on startup without embedding credentials or machine paths', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  expect(settings).toEqual({
    hooks: {
      SessionStart: [{
        matcher: 'startup',
        hooks: [{
          type: 'command',
          command: 'bash "$CLAUDE_PROJECT_DIR/scripts/claude-cloud-setup.sh"',
          timeout: 600,
        }],
      }],
    },
  });
});
