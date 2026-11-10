import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { render } from '../../hud/render.js';
import { parseTranscript } from '../../hud/transcript.js';
import { sanitizeOutput } from '../../hud/sanitize.js';
import { resetContextDisplayState } from '../../hud/elements/context.js';
import {
  PROMPT_CACHE_MISS_MIN_WRITE_TOKENS,
  renderPromptCache,
} from '../../hud/elements/prompt-cache.js';
import {
  DEFAULT_ELEMENT_ORDER,
  DEFAULT_HUD_CONFIG,
  PRESET_CONFIGS,
  resolveHudLabels,
  type HudConfig,
  type HudRenderContext,
  type PromptCacheUsage,
} from '../../hud/types.js';

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const tempDirs: string[] = [];

function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, '');
}

function createTempTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-hud-prompt-cache-'));
  tempDirs.push(dir);
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

/** Shape of a recorded Claude Code assistant transcript line. */
function assistantLine(
  id: string,
  usage: { input: number; write: number; read: number },
  extra: Record<string, unknown> = {},
) {
  const { input: i, write: w, read: r } = usage;
  return {
    type: 'assistant',
    sessionId: 'session-a',
    timestamp: '2026-11-09T12:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: i,
        cache_creation_input_tokens: w,
        cache_read_input_tokens: r,
        output_tokens: 200,
        service_tier: 'standard',
      },
      ...extra,
    },
  };
}

function usageOf(
  last: { input: number; write: number; read: number },
  session: { input: number; write: number; read: number },
  turns: number,
  complete = true,
): PromptCacheUsage {
  const turn = (t: { input: number; write: number; read: number }) => ({
    inputTokens: t.input,
    cacheCreationTokens: t.write,
    cacheReadTokens: t.read,
  });
  return { last: turn(last), session: turn(session), turns, complete };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderPromptCache', () => {
  it('renders nothing without usage data', () => {
    expect(renderPromptCache(null)).toBeNull();
    expect(renderPromptCache(undefined)).toBeNull();
    expect(renderPromptCache(usageOf({ input: 0, write: 0, read: 0 }, { input: 0, write: 0, read: 0 }, 0))).toBeNull();
    expect(renderPromptCache(usageOf({ input: 0, write: 0, read: 0 }, { input: 0, write: 0, read: 0 }, 1))).toBeNull();
  });

  it('marks zero reads on the first turn as new, not as a miss', () => {
    const out = stripAnsi(
      renderPromptCache(usageOf({ input: 3, write: 21_000, read: 0 }, { input: 3, write: 21_000, read: 0 }, 1)) ?? '',
    );
    expect(out).toBe('cache:w21.0k/r0 new');
    expect(out).not.toContain('MISS');
  });

  it('renders a hit with latest-turn counts and the session hit rate', () => {
    const out = stripAnsi(
      renderPromptCache(
        usageOf({ input: 10, write: 1_200, read: 45_000 }, { input: 40, write: 22_200, read: 90_000 }, 3),
      ) ?? '',
    );
    // session: 90000 / (90000 + 22200 + 40) = 80%
    expect(out).toBe('cache:w1.2k/r45.0k s80%');
  });

  it('renders a partial hit without a miss mark', () => {
    const out = stripAnsi(
      renderPromptCache(
        usageOf({ input: 0, write: 30_000, read: 10_000 }, { input: 0, write: 50_000, read: 10_000 }, 2),
      ) ?? '',
    );
    expect(out).toBe('cache:w30.0k/r10.0k s17%');
    expect(out).not.toContain('MISS');
  });

  it('marks a large write with zero reads after the first turn as MISS in text', () => {
    const out = stripAnsi(
      renderPromptCache(
        usageOf({ input: 2, write: 48_000, read: 0 }, { input: 5, write: 69_000, read: 100_000 }, 4),
      ) ?? '',
    );
    expect(out).toBe('cache:w48.0k/r0 MISS s59%');
  });

  it('does not call a small write with zero reads a miss', () => {
    const below = PROMPT_CACHE_MISS_MIN_WRITE_TOKENS - 1;
    const small = stripAnsi(
      renderPromptCache(usageOf({ input: 1, write: below, read: 0 }, { input: 1, write: below + 9_000, read: 9_000 }, 2)) ?? '',
    );
    expect(small).not.toContain('MISS');

    const edge = stripAnsi(
      renderPromptCache(
        usageOf({ input: 1, write: PROMPT_CACHE_MISS_MIN_WRITE_TOKENS, read: 0 }, { input: 1, write: 9_000, read: 9_000 }, 2),
      ) ?? '',
    );
    expect(edge).toContain('MISS');
  });

  it('does not treat the first turn of a tail-read transcript as the session start', () => {
    const out = stripAnsi(
      renderPromptCache(
        usageOf({ input: 3, write: 21_000, read: 0 }, { input: 3, write: 21_000, read: 0 }, 1, false),
      ) ?? '',
    );
    expect(out).toContain('MISS');
    expect(out).not.toContain('new');
  });

  it('uses the shared token formatter for very large numbers', () => {
    const out = stripAnsi(
      renderPromptCache(
        usageOf({ input: 0, write: 0, read: 1_250_000 }, { input: 0, write: 0, read: 3_000_000 }, 9),
      ) ?? '',
    );
    expect(out).toBe('cache:w0/r1.25M s100%');
  });

  it('applies the configured cache label', () => {
    const out = stripAnsi(
      renderPromptCache(
        usageOf({ input: 0, write: 100, read: 900 }, { input: 0, write: 100, read: 900 }, 2),
        resolveHudLabels('zh-CN'),
      ) ?? '',
    );
    expect(out).toBe('缓存:w100/r900 s90%');
  });

  it('keeps the miss and first-turn signals when colour is stripped', () => {
    const miss = renderPromptCache(usageOf({ input: 0, write: 9_000, read: 0 }, { input: 0, write: 9_000, read: 0 }, 2)) ?? '';
    const plain = stripAnsi(miss);
    expect(plain).toContain('MISS');
    expect(plain).toContain('w9.0k/r0');
  });
});

describe('HUD transcript prompt-cache plumbing', () => {
  it('captures the latest turn and session sums from message.usage', async () => {
    const transcriptPath = createTempTranscript([
      assistantLine('msg_1', { input: 3, write: 20_000, read: 0 }),
      assistantLine('msg_2', { input: 5, write: 1_000, read: 20_000 }),
    ]);

    const result = await parseTranscript(transcriptPath);

    expect(result.promptCache).toEqual({
      last: { inputTokens: 5, cacheCreationTokens: 1_000, cacheReadTokens: 20_000 },
      session: { inputTokens: 8, cacheCreationTokens: 21_000, cacheReadTokens: 20_000 },
      turns: 2,
      complete: true,
    });
  });

  it('counts one request once when its content blocks are written as several lines', async () => {
    const transcriptPath = createTempTranscript([
      assistantLine('msg_1', { input: 3, write: 20_000, read: 0 }),
      assistantLine('msg_1', { input: 3, write: 20_000, read: 0 }),
      assistantLine('msg_1', { input: 3, write: 20_000, read: 0 }),
    ]);

    const result = await parseTranscript(transcriptPath);

    expect(result.promptCache?.turns).toBe(1);
    expect(result.promptCache?.session.cacheCreationTokens).toBe(20_000);
  });

  it('ignores all-zero usage and entries without cache data', async () => {
    const transcriptPath = createTempTranscript([
      assistantLine('msg_synthetic', { input: 0, write: 0, read: 0 }),
      { type: 'user', message: { content: 'hello' } },
    ]);

    const result = await parseTranscript(transcriptPath);

    expect(result.promptCache).toBeUndefined();
  });

  it('keeps cached results isolated between repeated parses', async () => {
    const transcriptPath = createTempTranscript([assistantLine('msg_1', { input: 3, write: 20_000, read: 0 })]);

    const first = await parseTranscript(transcriptPath);
    first.promptCache!.last.cacheReadTokens = 999;
    first.promptCache!.session.cacheReadTokens = 999;

    const second = await parseTranscript(transcriptPath);
    expect(second.promptCache?.last.cacheReadTokens).toBe(0);
    expect(second.promptCache?.session.cacheReadTokens).toBe(0);
  });
});

describe('prompt cache element registration and defaults', () => {
  it('is off by default and in every preset', () => {
    expect(DEFAULT_HUD_CONFIG.elements.showPromptCache).toBe(false);
    for (const preset of ['minimal', 'focused', 'full', 'opencode', 'dense'] as const) {
      expect(PRESET_CONFIGS[preset].showPromptCache).toBe(false);
    }
  });

  it('is ordered right after tokens in the default main line', () => {
    const main = DEFAULT_ELEMENT_ORDER.main;
    expect(main.indexOf('promptCache')).toBe(main.indexOf('tokens') + 1);
  });
});

describe('prompt cache through the composed HUD renderer', () => {
  beforeEach(() => {
    resetContextDisplayState();
  });

  function createContext(promptCache: PromptCacheUsage | null): HudRenderContext {
    return {
      contextPercent: 40,
      modelName: 'claude-sonnet-5-5',
      ralph: null,
      ultrawork: null,
      prd: null,
      autopilot: null,
      activeAgents: [],
      todos: [],
      backgroundTasks: [],
      cwd: '/home/user/project',
      lastSkill: null,
      rateLimitsResult: null,
      customBuckets: null,
      pendingPermission: null,
      thinkingState: null,
      sessionHealth: null,
      lastRequestTokenUsage: null,
      sessionTotalTokens: null,
      promptCache,
      omcVersion: null,
      updateAvailable: null,
      toolCallCount: 0,
      agentCallCount: 0,
      skillCallCount: 0,
      promptTime: null,
      apiKeySource: null,
      profileName: null,
      sessionSummary: null,
    };
  }

  function createConfig(showPromptCache: boolean, overrides: Partial<HudConfig> = {}): HudConfig {
    return {
      ...DEFAULT_HUD_CONFIG,
      ...overrides,
      elements: {
        ...DEFAULT_HUD_CONFIG.elements,
        omcLabel: false,
        rateLimits: false,
        thinking: false,
        promptTime: false,
        sessionHealth: false,
        showCallCounts: false,
        showPromptCache,
        useBars: false,
        gitBranch: false,
        gitStatus: false,
      },
    };
  }

  it('renders a hit then a miss from a recorded-shape transcript, and nothing when off', async () => {
    const hitPath = createTempTranscript([
      assistantLine('msg_1', { input: 3, write: 20_000, read: 0 }),
      assistantLine('msg_2', { input: 4, write: 900, read: 20_000 }),
    ]);
    const missPath = createTempTranscript([
      assistantLine('msg_1', { input: 3, write: 20_000, read: 0 }),
      assistantLine('msg_2', { input: 4, write: 900, read: 20_000 }),
      assistantLine('msg_3', { input: 2, write: 21_500, read: 0 }),
    ]);

    const hit = await parseTranscript(hitPath);
    const miss = await parseTranscript(missPath);

    const hitOut = stripAnsi(await render(createContext(hit.promptCache ?? null), createConfig(true)));
    const missOut = stripAnsi(await render(createContext(miss.promptCache ?? null), createConfig(true)));
    const offOut = stripAnsi(await render(createContext(hit.promptCache ?? null), createConfig(false)));

    expect(hitOut).toContain('cache:w900/r20.0k s49%');
    expect(missOut).toContain('cache:w21.5k/r0 MISS');
    expect(offOut).not.toContain('cache:');
  });

  it('renders nothing before any usage exists', async () => {
    const out = stripAnsi(await render(createContext(null), createConfig(true)));
    expect(out).not.toContain('cache:');
  });

  it('truncates to maxWidth with the shared ellipsis helper', async () => {
    const usage = usageOf({ input: 2, write: 21_500, read: 0 }, { input: 5, write: 40_000, read: 20_000 }, 3);
    const out = stripAnsi(await render(createContext(usage), createConfig(true, { maxWidth: 20 })));
    for (const line of out.split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(20);
    }
  });

  it('stays ASCII-only through the safe-mode sanitizer and keeps the miss mark', async () => {
    const usage = usageOf({ input: 2, write: 21_500, read: 0 }, { input: 5, write: 40_000, read: 20_000 }, 3);
    const rendered = await render(createContext(usage), createConfig(true));
    // index.ts runs this over the rendered line when elements.safeMode is on.
    const out = stripAnsi(sanitizeOutput(rendered));
    expect(out).toMatch(/^[\x20-\x7e\n]*$/);
    expect(out).toContain('cache:w21.5k/r0 MISS');
  });
});
