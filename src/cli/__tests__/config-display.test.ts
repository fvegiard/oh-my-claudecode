import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getConfigWarnings, redactSensitiveConfig, REDACTED } from '../config-display.js';

describe('redactSensitiveConfig', () => {
  it('redacts sensitive keys recursively, case-insensitively, including arrays', () => {
    const input = {
      mcpServers: { exa: { enabled: true, apiKey: 'sentinel-a' } },
      notifications: {
        slack: { WebhookUrl: 'sentinel-b' },
        telegram: { botToken: 'sentinel-c', chatId: '1' },
        list: [{ client_secret: 'sentinel-d' }, { name: 'ok' }],
      },
      db: { PASSWORD: 'sentinel-e' },
      webhook: { url: 'sentinel-f' },
      EXA_API_KEY: 'sentinel-g',
    };

    const output = redactSensitiveConfig(input);
    const text = JSON.stringify(output);

    for (const letter of 'abcdefg') {
      expect(text).not.toContain(`sentinel-${letter}`);
    }
    expect(output).toEqual({
      mcpServers: { exa: { enabled: true, apiKey: REDACTED } },
      notifications: {
        slack: { WebhookUrl: REDACTED },
        telegram: { botToken: REDACTED, chatId: '1' },
        list: [{ client_secret: REDACTED }, { name: 'ok' }],
      },
      db: { PASSWORD: REDACTED },
      webhook: REDACTED,
      EXA_API_KEY: REDACTED,
    });
  });

  it('keeps unset and numeric values and does not mutate its input', () => {
    const input = { apiKey: '', maxTokens: 10, token: null, nested: { secret: 'x' } };
    const snapshot = JSON.parse(JSON.stringify(input));

    expect(redactSensitiveConfig(input)).toEqual({
      apiKey: '',
      maxTokens: 10,
      token: null,
      nested: { secret: REDACTED },
    });
    expect(input).toEqual(snapshot);
  });
});

describe('getConfigWarnings', () => {
  const noExa = {};

  it('warns about missing authentication only when no supported source exists', () => {
    const warnings = getConfigWarnings(noExa, {}, false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(warnings[0]).toMatch(/ANTHROPIC_API_KEY/);
  });

  it.each([
    ['Claude subscription login', {}, true],
    ['CLAUDE_CODE_OAUTH_TOKEN', { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, false],
    ['ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_TOKEN: 'x' }, false],
    ['ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'x' }, false],
    ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }, false],
    ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }, false],
    ['Foundry', { CLAUDE_CODE_USE_FOUNDRY: 'true' }, false],
    ['Anthropic AWS', { CLAUDE_CODE_USE_ANTHROPIC_AWS: 'TRUE' }, false],
  ])('does not warn when %s is available', (_label, env, login) => {
    expect(getConfigWarnings(noExa, env, login)).toEqual([]);
  });

  it.each(['0', 'false', 'no', ''])('does not treat provider flag value %j as enabled', (value) => {
    for (const flag of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    ]) {
      const warnings = getConfigWarnings(noExa, { [flag]: value }, false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/No Claude authentication/);
    }
  });

  it('warns when Exa is enabled without a key, and not when a key exists', () => {
    const exa = { mcpServers: { exa: { enabled: true } } };
    expect(getConfigWarnings(exa, { ANTHROPIC_API_KEY: 'x' }, false)).toEqual([
      'Exa is enabled but EXA_API_KEY is not set',
    ]);
    expect(getConfigWarnings(exa, { ANTHROPIC_API_KEY: 'x', EXA_API_KEY: 'k' }, false)).toEqual([]);
    expect(
      getConfigWarnings({ mcpServers: { exa: { enabled: true, apiKey: 'k' } } }, { ANTHROPIC_API_KEY: 'x' }, false),
    ).toEqual([]);
  });
});

describe('omc config output', () => {
  const SENTINEL = 'sentinel-exa-key-do-not-leak-0123456789';
  const WEBHOOK_SENTINEL = 'https://hooks.example.invalid/sentinel-webhook-do-not-leak';
  const touched = ['EXA_API_KEY', 'XDG_CONFIG_HOME', 'OMC_CLI_SKIP_PARSE'] as const;
  let saved: Record<string, string | undefined>;
  let originalCwd: string;
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    saved = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'omc-config-print-'));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tempDir, '.claude', 'omc.jsonc'),
      JSON.stringify({ notifications: { slack: { webhookUrl: WEBHOOK_SENTINEL } } }),
    );
    process.env.XDG_CONFIG_HOME = join(tempDir, 'xdg');
    process.env.EXA_API_KEY = SENTINEL;
    process.env.OMC_CLI_SKIP_PARSE = '1';
    process.chdir(tempDir);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    for (const key of touched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('never prints secret values from the environment or config files', async () => {
    const { buildProgram } = await import('../index.js');
    await buildProgram().parseAsync(['config'], { from: 'user' });

    const output = logs.join('\n');
    expect(output).toContain('Current configuration');
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(WEBHOOK_SENTINEL);
  });
});
