import { describe, expect, it } from 'vitest';

import { render } from '../../hud/render.js';
import { resetContextDisplayState } from '../../hud/elements/context.js';
import {
  formatCacheTtl,
  parseOfficialPromptCache,
  renderPromptCache,
} from '../../hud/elements/prompt-cache.js';
import {
  DEFAULT_HUD_CONFIG,
  resolveHudLabels,
  type HudRenderContext,
  type PromptCacheUsage,
} from '../../hud/types.js';

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const strip = (value: string | null): string => (value ?? '').replace(ANSI_REGEX, '');

/** Real statusLine stdin sample from Claude Code 2.1.311 (prompt_cache and current_usage). */
const REAL_PROMPT_CACHE = {
  warm: true,
  caching_observed: true,
  ttl: '1h',
  expires_at: 1794291312,
  requests: 308,
  misses: 1,
  expected_rebuilds: 1,
  hit_ratio: 0.9906763961535705,
  cache_write_tokens: 1765293,
  miss_recache_tokens: 745749,
  last_miss_at: 1794283075,
  last_miss_cause: { causes: ['likely_server_side'] },
  miss_causes: { likely_server_side: 1 },
  recache_tokens_if_cold: 108979,
};
const REAL_CURRENT_USAGE = {
  input_tokens: 2,
  output_tokens: 8,
  cache_creation_input_tokens: 1818,
  cache_read_input_tokens: 108977,
};

/** 56m24s before the sample's expires_at. */
const NOW_MS = (1794291312 - 3384) * 1000;

function stdinOf(promptCache: unknown, currentUsage: unknown = REAL_CURRENT_USAGE): unknown {
  return { prompt_cache: promptCache, context_window: { current_usage: currentUsage } };
}

function officialOf(overrides: Record<string, unknown> = {}, currentUsage: unknown = REAL_CURRENT_USAGE) {
  return parseOfficialPromptCache(stdinOf({ ...REAL_PROMPT_CACHE, ...overrides }, currentUsage));
}

function transcriptUsage(
  last: { input: number; write: number; read: number },
  turns = 10,
  previousPromptTokens?: number,
): PromptCacheUsage {
  const turn = { inputTokens: last.input, cacheCreationTokens: last.write, cacheReadTokens: last.read };
  return {
    last: turn,
    session: { ...turn },
    turns,
    complete: true,
    ...(previousPromptTokens === undefined ? {} : { previousPromptTokens }),
  };
}

describe('parseOfficialPromptCache', () => {
  it('parses the real 2.1.311 sample', () => {
    const parsed = officialOf();
    expect(parsed?.cache.hit_ratio).toBe(0.9906763961535705);
    expect(parsed?.cache.expires_at).toBe(1794291312);
    expect(parsed?.cache.last_miss_cause).toEqual({ causes: ['likely_server_side'] });
    expect(parsed?.currentUsage).toEqual({ inputTokens: 2, cacheCreationTokens: 1818, cacheReadTokens: 108977 });
  });

  it('returns null for an absent, non-object or empty prompt_cache (older Claude Code)', () => {
    expect(parseOfficialPromptCache({})).toBeNull();
    expect(parseOfficialPromptCache({ context_window: { current_usage: REAL_CURRENT_USAGE } })).toBeNull();
    expect(parseOfficialPromptCache(null)).toBeNull();
    expect(parseOfficialPromptCache('x')).toBeNull();
    expect(parseOfficialPromptCache({ prompt_cache: 'warm' })).toBeNull();
    expect(parseOfficialPromptCache({ prompt_cache: [1, 2] })).toBeNull();
    expect(parseOfficialPromptCache({ prompt_cache: {} })).toBeNull();
    expect(parseOfficialPromptCache({ prompt_cache: { requests: 3, brand_new_key: true } })).toBeNull();
  });

  it('returns null when caching is not observed', () => {
    expect(officialOf({ caching_observed: false })).toBeNull();
  });

  it('drops wrong-typed fields instead of throwing', () => {
    const parsed = parseOfficialPromptCache(
      stdinOf({
        warm: 'yes',
        ttl: 3600,
        expires_at: '1794291312',
        misses: -4,
        requests: Number.NaN,
        hit_ratio: 4,
        recache_tokens_if_cold: { n: 1 },
        last_miss_at: null,
        last_miss_cause: { causes: 'tools_changed' },
        miss_causes: ['x'],
        extra: { nested: true },
      }, 'garbage'),
    );
    expect(parsed).toBeNull();

    const partial = parseOfficialPromptCache(
      stdinOf({ hit_ratio: 0.5, warm: 7, expires_at: 'soon', last_miss_cause: { causes: [1, null, 'tools_changed'] } }, { cache_read_input_tokens: 5 }),
    );
    expect(partial?.cache).toEqual({ hit_ratio: 0.5, last_miss_cause: { causes: ['tools_changed'] } });
    expect(partial?.currentUsage).toBeUndefined();
  });

  it('keeps unknown extra keys out and tolerates a null last_miss_cause and miss_causes', () => {
    const parsed = officialOf({ last_miss_cause: null, miss_causes: null, future_field: 1 });
    expect(parsed?.cache.last_miss_cause).toBeUndefined();
    expect(parsed?.cache).not.toHaveProperty('future_field');
  });
});

describe('parseOfficialPromptCache counters (PC-3)', () => {
  it('keeps only safe non-negative integers for requests, misses and expected_rebuilds', () => {
    const parsed = officialOf({ requests: 1.5, misses: 1e21, expected_rebuilds: -1 });
    expect(parsed?.cache.requests).toBeUndefined();
    expect(parsed?.cache.misses).toBeUndefined();
    expect(parsed?.cache.expected_rebuilds).toBeUndefined();
    const ok = officialOf({ requests: 308, misses: 0, expected_rebuilds: 2 });
    expect(ok?.cache).toMatchObject({ requests: 308, misses: 0, expected_rebuilds: 2 });
    expect(officialOf({ misses: Number.MAX_SAFE_INTEGER })?.cache.misses).toBe(Number.MAX_SAFE_INTEGER);
    expect(officialOf({ misses: Number.MAX_SAFE_INTEGER + 2 })?.cache.misses).toBeUndefined();
  });

  it('never prints a fractional or exponent miss count', () => {
    for (const misses of [1.5, 1e21]) {
      const out = strip(renderPromptCache(null, undefined, officialOf({ misses }), NOW_MS));
      expect(out).not.toMatch(/miss:/);
    }
  });

  it('floors the hit ratio so 100% means 100%', () => {
    expect(strip(renderPromptCache(null, undefined, officialOf({ hit_ratio: 0.996 }), NOW_MS))).toContain(' 99% ');
    expect(strip(renderPromptCache(null, undefined, officialOf({ hit_ratio: 1 }), NOW_MS))).toContain(' 100% ');
    expect(strip(renderPromptCache(null, undefined, officialOf({ hit_ratio: 0.29 }), NOW_MS))).toContain(' 29% ');
  });

  it('formatCacheTtl returns an empty string for non-finite input', () => {
    expect(formatCacheTtl(Number.NaN)).toBe('');
    expect(formatCacheTtl(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatCacheTtl(Number.NEGATIVE_INFINITY)).toBe('');
  });
});

describe('ttl countdown bounds (PC-2)', () => {
  const expiresAt = 1794291312;
  const ttlOf = (overrides: Record<string, unknown>, nowSeconds: number) =>
    strip(renderPromptCache(null, undefined, officialOf(overrides), nowSeconds * 1000));

  it('clamps to the declared ttl when the local clock runs behind', () => {
    expect(ttlOf({ ttl: '1h' }, expiresAt - 7200)).toContain('ttl:1h00m');
    expect(ttlOf({ ttl: '5m' }, expiresAt - 600)).toContain('ttl:5m');
    expect(ttlOf({ ttl: '5m' }, expiresAt - 200)).toContain('ttl:3m');
  });

  it('drops the countdown when the remaining time is more than twice the ttl', () => {
    expect(ttlOf({ ttl: '1h' }, expiresAt - 7201)).not.toContain('ttl:');
    expect(ttlOf({ ttl: '5m' }, expiresAt - 601)).not.toContain('ttl:');
    expect(ttlOf({ ttl: '1h', expires_at: expiresAt * 1000 }, expiresAt)).not.toMatch(/ttl:|NaN|Infinity/);
  });

  it('bounds an unknown or absent ttl by the largest documented one', () => {
    expect(ttlOf({ ttl: undefined }, expiresAt - 5000)).toContain('ttl:1h00m');
    expect(ttlOf({ ttl: '24h' }, expiresAt - 7200)).toContain('ttl:1h00m');
    expect(ttlOf({ ttl: undefined }, expiresAt - 7201)).not.toContain('ttl:');
  });
});

describe('formatCacheTtl boundaries', () => {
  it.each([
    [59, '<1m'],
    [60, '1m'],
    [119, '1m'],
    [3599, '59m'],
    [59 * 60 + 59, '59m'],
    [3600, '1h00m'],
    [3600 + 5 * 60, '1h05m'],
    [3600 + 5 * 60 + 59, '1h05m'],
    [7200 + 59 * 60, '2h59m'],
  ])('%i s -> %s', (seconds, expected) => {
    expect(formatCacheTtl(seconds)).toBe(expected);
  });
});

describe('renderPromptCache with the official prompt_cache', () => {
  it('renders the real sample as a normal warm segment', () => {
    expect(strip(renderPromptCache(null, undefined, officialOf(), NOW_MS))).toBe(
      'cache:w1.8k/r109.0k 99% miss:1 ttl:56m',
    );
  });

  it('uses the official session hit ratio instead of the transcript sNN%', () => {
    const out = strip(
      renderPromptCache(transcriptUsage({ input: 1, write: 10, read: 20 }), undefined, officialOf(), NOW_MS),
    );
    expect(out).toContain(' 99% ');
    expect(out).not.toMatch(/ s\d+%/);
  });

  it('omits miss: when misses is 0 and ttl when expires_at is absent', () => {
    const out = strip(
      renderPromptCache(null, undefined, officialOf({ misses: 0, expires_at: undefined, last_miss_at: null }), NOW_MS),
    );
    expect(out).toBe('cache:w1.8k/r109.0k 99%');
  });

  it('renders a cold cache with the rebuild estimate', () => {
    expect(strip(renderPromptCache(null, undefined, officialOf({ warm: false }), NOW_MS))).toBe(
      'cache:COLD rebuild~109.0k 99% miss:1',
    );
  });

  it('renders COLD when expires_at is in the past, and exactly at expiry', () => {
    const pastExpiry = (1794291312 + 1) * 1000;
    expect(strip(renderPromptCache(null, undefined, officialOf(), pastExpiry))).toBe(
      'cache:COLD rebuild~109.0k 99% miss:1',
    );
    expect(strip(renderPromptCache(null, undefined, officialOf(), 1794291312 * 1000))).toContain('COLD');
  });

  it('omits the rebuild part when recache_tokens_if_cold is absent', () => {
    const out = strip(
      renderPromptCache(null, undefined, officialOf({ warm: false, recache_tokens_if_cold: null, misses: 0 }), NOW_MS),
    );
    expect(out).toBe('cache:COLD 99%');
  });

  it('shows the cold marker for a warm=false cache even when expires_at is null', () => {
    const out = strip(renderPromptCache(null, undefined, officialOf({ warm: false, expires_at: null }), NOW_MS));
    expect(out).toContain('cache:COLD');
  });

  it('marks a rebuild MISS with the official cause when the miss is recent', () => {
    const rebuild = { input: 1, write: 745_749, read: 33_635 };
    const official = officialOf(
      { misses: 2, last_miss_at: NOW_MS / 1000 - 30 },
      { input: 1, output_tokens: 5, cache_creation_input_tokens: 745_749, cache_read_input_tokens: 33_635 },
    );
    const out = strip(renderPromptCache(transcriptUsage(rebuild, 40, 772_600), undefined, official, NOW_MS));
    expect(out).toBe('cache:w745.7k/r33.6k MISS(server) 99% miss:2 ttl:56m');
  });

  it('shows MISS with its cause up to 120 s after the official miss, then a neutral rebuild', () => {
    const current = { input: 1, cache_creation_input_tokens: 48_000, cache_read_input_tokens: 0 };
    const at = (ageSeconds: number) =>
      strip(
        renderPromptCache(null, undefined, officialOf({ last_miss_at: NOW_MS / 1000 - ageSeconds }, current), NOW_MS),
      );
    expect(at(120)).toContain('MISS(server)');
    expect(at(121)).toContain(' rebuild ');
    expect(at(121)).not.toContain('MISS');
  });

  it('keeps MISS for an official object with no miss data at all', () => {
    const current = { input: 1, cache_creation_input_tokens: 48_000, cache_read_input_tokens: 0 };
    const out = strip(
      renderPromptCache(
        null,
        undefined,
        officialOf({ misses: undefined, last_miss_at: undefined, last_miss_cause: undefined }, current),
        NOW_MS,
      ),
    );
    expect(out).toContain(' MISS ');
  });

  it('PC-1: a compaction rebuild (expected_rebuilds up, last miss 83 min old, recache null) is a yellow rebuild, not a red MISS', () => {
    const official = officialOf(
      { requests: 120, misses: 1, expected_rebuilds: 2, last_miss_at: NOW_MS / 1000 - 5000, recache_tokens_if_cold: null },
      { input: 1, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 15_000 },
    );
    const coloured = renderPromptCache(transcriptUsage({ input: 1, write: 30_000, read: 15_000 }, 120, 798_000), undefined, official, NOW_MS) ?? '';
    expect(strip(coloured)).toBe('cache:w30.0k/r15.0k rebuild 99% miss:1 ttl:56m');
    expect(strip(coloured)).not.toContain('MISS');
    expect(coloured).not.toContain('\x1b[31m');
  });

  it('PC-1: an official misses:0 with a null last_miss_at also gives a rebuild, not MISS', () => {
    const official = officialOf(
      { misses: 0, last_miss_at: null, last_miss_cause: null },
      { input: 1, cache_creation_input_tokens: 48_000, cache_read_input_tokens: 0 },
    );
    expect(strip(renderPromptCache(null, undefined, official, NOW_MS))).toBe('cache:w48.0k/r0 rebuild 99% ttl:56m');
  });

  it('maps every documented cause and strips likely_ from unknown ones', () => {
    const current = { input: 1, cache_creation_input_tokens: 48_000, cache_read_input_tokens: 0 };
    const withCauses = (causes: string[]) =>
      strip(
        renderPromptCache(
          null,
          undefined,
          officialOf({ last_miss_at: NOW_MS / 1000 - 5, last_miss_cause: { causes } }, current),
          NOW_MS,
        ),
      );
    expect(withCauses(['tools_changed'])).toContain('MISS(tools)');
    expect(withCauses(['system_prompt_changed'])).toContain('MISS(system)');
    expect(withCauses(['ttl_expired_5m'])).toContain('MISS(ttl5m)');
    expect(withCauses(['ttl_expired_1h'])).toContain('MISS(ttl1h)');
    expect(withCauses(['likely_server_side'])).toContain('MISS(server)');
    expect(withCauses(['likely_gateway_rewrite'])).toContain('MISS(gateway_rewrite)');
    expect(withCauses(['Some New Cause!'])).toContain('MISS(somenewcause)');
    expect(withCauses(['tools_changed', 'system_prompt_changed', 'ttl_expired_5m'])).toContain('MISS(tools+system)');
    expect(withCauses(['\x1b[31mtools_changed'])).not.toContain('\x1b');
  });

  it('does not flag MISS from an official miss counter alone (a healthy latest request stays a hit)', () => {
    const out = strip(renderPromptCache(null, undefined, officialOf({ last_miss_at: NOW_MS / 1000 - 5 }), NOW_MS));
    expect(out).not.toContain('MISS');
  });

  it('prefers current_usage and falls back to the transcript last turn without it', () => {
    const transcript = transcriptUsage({ input: 3, write: 900, read: 20_000 }, 5, 20_000);
    const withUsage = strip(renderPromptCache(transcript, undefined, officialOf(), NOW_MS));
    expect(withUsage).toContain('w1.8k/r109.0k');
    const noUsage = strip(renderPromptCache(transcript, undefined, officialOf({}, null), NOW_MS));
    expect(noUsage).toContain('w900/r20.0k');
  });

  it('shows only the official numbers when no request counts exist anywhere', () => {
    const out = strip(renderPromptCache(null, undefined, officialOf({}, null), NOW_MS));
    expect(out).toBe('cache:99% miss:1 ttl:56m');
  });

  it('marks the first official request as new, not a miss', () => {
    const out = strip(
      renderPromptCache(
        null,
        undefined,
        officialOf({ requests: 1, misses: 0, hit_ratio: 0 }, { input: 3, cache_creation_input_tokens: 21_000, cache_read_input_tokens: 0 }),
        NOW_MS,
      ),
    );
    expect(out).toBe('cache:w21.0k/r0 new 0% ttl:56m');
  });

  it('treats a transcript one request behind the stdin as the previous request', () => {
    // stdin: w60000 r40000 against a previous prompt of 100003 (transcript last): collapsed read, big write.
    const transcript = transcriptUsage({ input: 3, write: 0, read: 100_000 }, 5, 90_000);
    const official = officialOf(
      { last_miss_at: NOW_MS / 1000 - 3 },
      { input: 1, cache_creation_input_tokens: 60_000, cache_read_input_tokens: 40_000 },
    );
    expect(strip(renderPromptCache(transcript, undefined, official, NOW_MS))).toContain('MISS');
  });

  it('applies the configured cache label', () => {
    expect(strip(renderPromptCache(null, resolveHudLabels('zh-CN'), officialOf(), NOW_MS))).toBe(
      '缓存:w1.8k/r109.0k 99% miss:1 ttl:56m',
    );
  });

  it('keeps colour secondary: stripped output carries every marker', () => {
    const coloured = renderPromptCache(null, undefined, officialOf({ warm: false }), NOW_MS) ?? '';
    expect(coloured).toMatch(ANSI_REGEX);
    expect(strip(coloured)).toContain('COLD');
  });

  it('falls back to the transcript when caching_observed is false and renders nothing without transcript data', () => {
    const official = officialOf({ caching_observed: false });
    expect(official).toBeNull();
    const transcript = transcriptUsage({ input: 10, write: 1_200, read: 45_000 }, 3);
    expect(strip(renderPromptCache(transcript, undefined, official, NOW_MS))).toBe('cache:w1.2k/r45.0k s97%');
    expect(renderPromptCache(null, undefined, official, NOW_MS)).toBeNull();
  });

  it('survives garbage without throwing and without leaking undefined/NaN', () => {
    const odd = parseOfficialPromptCache(
      stdinOf({ warm: true, hit_ratio: 'x', expires_at: { a: 1 }, misses: 'many' }, [1, 2]),
    );
    const out = strip(renderPromptCache(null, undefined, odd, NOW_MS));
    expect(out).toBe('');
    expect(`${out}`).not.toMatch(/NaN|undefined/);
  });
});

describe('absent official object keeps the transcript output byte-identical', () => {
  const usage = transcriptUsage({ input: 10, write: 1_200, read: 45_000 }, 3);

  it('is the same with undefined, null and an unparsable stdin', () => {
    const baseline = renderPromptCache(usage);
    expect(strip(baseline)).toBe('cache:w1.2k/r45.0k s97%');
    expect(renderPromptCache(usage, undefined, null, NOW_MS)).toBe(baseline);
    expect(renderPromptCache(usage, undefined, parseOfficialPromptCache({ prompt_cache: 'bad' }), NOW_MS)).toBe(baseline);
    expect(renderPromptCache(usage, undefined, parseOfficialPromptCache({}), NOW_MS)).toBe(baseline);
  });
});

describe('official prompt cache through the composed HUD renderer', () => {
  function createContext(official: ReturnType<typeof parseOfficialPromptCache>): HudRenderContext {
    resetContextDisplayState();
    return {
      contextPercent: 40,
      modelName: 'claude-fable-5-2',
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
      promptCache: null,
      promptCacheOfficial: official,
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

  const config = (showPromptCache: boolean) => ({
    ...DEFAULT_HUD_CONFIG,
    elements: {
      ...DEFAULT_HUD_CONFIG.elements,
      omcLabel: false,
      rateLimits: false,
      thinking: false,
      promptTime: false,
      sessionHealth: false,
      showCallCounts: false,
      showPromptCache,
      gitBranch: false,
      gitStatus: false,
    },
  });

  it('renders the official segment only when showPromptCache is true', async () => {
    const on = strip(await render(createContext(officialOf()), config(true)));
    const off = strip(await render(createContext(officialOf()), config(false)));
    expect(on).toMatch(/cache:w1\.8k\/r109\.0k 99% miss:1 ttl:\d+[mh]/);
    expect(off).not.toContain('cache:');
  });
});
