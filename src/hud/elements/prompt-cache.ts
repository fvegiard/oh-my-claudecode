/**
 * OMC HUD - Prompt Cache Element
 *
 * Two sources. With Claude Code 2.1.251+ the statusline stdin carries an
 * official `prompt_cache` object and the element renders from it. Without it
 * (older Claude Code, caching_observed false, or nothing usable in it) the
 * element falls back to transcript message.usage, unchanged.
 *
 * Official path (text markers carry the signal, colour is secondary):
 *   cache:w1.8k/r109.0k 99% miss:1 ttl:56m   normal: latest request write/read,
 *                                            official session hit ratio, misses
 *                                            (only when > 0), time to expiry
 *   cache:COLD rebuild~109.0k 99% miss:1     cold: not warm, or expires_at passed
 *   cache:w48.0k/r0 MISS(server) 99% miss:2 ttl:59m   latest request rebuilt the cache
 *   cache:w30.0k/r15.0k rebuild 97% miss:1 ttl:59m    big write, collapsed read, but Claude Code
 *                                            reports no recent miss (compaction or cleared
 *                                            tool results: an expected rebuild, yellow)
 *
 * Official numbers: hit ratio, misses, expiry, rebuild-if-cold, miss cause, and
 * the latest request write/read when read from context_window.current_usage.
 * Derived numbers: the MISS / rebuild marker (write >= 4096 and a collapsed
 * read; MISS only when the official miss data agrees), the ttl countdown
 * (expires_at minus now, bounded by the declared ttl), and counts taken from
 * the transcript when current_usage has none.
 *
 * Transcript fallback format:
 *   cache:w1.2k/r45.0k s97%      (hit or partial)
 *   cache:w21.0k/r0 new          (first request of a session, not a miss)
 *   cache:w48.0k/r0 MISS s83%    (cache rebuilt: expired or invalidated)
 *   cache:w114.6k/r28.9k MISS s90% (rebuilt while a shared prefix was still cached)
 */

import type {
  HudLabels,
  OfficialPromptCache,
  PromptCacheTurn,
  PromptCacheUsage,
  StatuslinePromptCache,
} from '../types.js';
import { DEFAULT_HUD_LABELS } from '../types.js';
import { parseOfficialPromptCache } from '../prompt-cache-stdin.js';
import { formatTokenCount } from '../../cli/utils/formatting.js';
import { green, yellow, red } from '../colors.js';

/**
 * A latest request counts as a rebuilt cache when it wrote at least this many
 * tokens and its read collapsed (see MISS_READ_SHARE_OF_PREVIOUS_PROMPT). 4096 is the largest minimum cacheable prompt length of
 * any Claude model, so a smaller write is ordinary new content, not a rebuild.
 */
export const PROMPT_CACHE_MISS_MIN_WRITE_TOKENS = 4096;

/**
 * A read below this share of the previous request's prompt means most of the
 * earlier prefix was not served from the cache. A shared system/tools prefix
 * can survive an expiry or invalidation, so the read is then small but not
 * zero; a normal turn reads back at least the whole previous prompt.
 */
const MISS_READ_SHARE_OF_PREVIOUS_PROMPT = 0.5;

/** Latest-request hit rate at or above which the cache counts as a hit (green). */
const HIT_RATE_THRESHOLD = 0.8;

function hitRate(read: number, written: number, uncached: number): number {
  const total = read + written + uncached;
  return total > 0 ? read / total : 0;
}

export { parseOfficialPromptCache };

/** Official last_miss_at counts as "the latest request" for the cause suffix within this many seconds. */
const RECENT_MISS_WINDOW_SECONDS = 120;

/** Documented `prompt_cache.ttl` values in seconds. */
const TTL_SECONDS: Record<string, number> = { '5m': 300, '1h': 3600 };

/** Largest documented TTL, the bound used when `ttl` is absent or unrecognised. */
const MAX_TTL_SECONDS = 3600;

/**
 * Seconds left on the cache, or null when unknown. The value is clamped to the
 * declared TTL (a local clock behind Claude Code's would otherwise show more
 * than the TTL) and a value over twice the TTL (clock skew, or an expires_at
 * sent in milliseconds) is treated as unknown.
 */
function remainingSecondsOf(cache: StatuslinePromptCache, nowSeconds: number): number | null {
  if (cache.expires_at === undefined || cache.expires_at === null) return null;
  const remaining = cache.expires_at - nowSeconds;
  if (!Number.isFinite(remaining)) return null;
  const ttl = (cache.ttl !== undefined ? TTL_SECONDS[cache.ttl] : undefined) ?? MAX_TTL_SECONDS;
  if (remaining > 2 * ttl) return null;
  return Math.min(remaining, ttl);
}

/** True when the official data carries miss information, so its silence about a miss is meaningful. */
function hasOfficialMissData(cache: StatuslinePromptCache): boolean {
  return (
    (cache.misses !== undefined && cache.misses !== null) ||
    (cache.last_miss_at !== undefined && cache.last_miss_at !== null)
  );
}

/** True when Claude Code's latest miss is recent enough to be the latest request. */
function officialMissIsRecent(cache: StatuslinePromptCache, nowSeconds: number): boolean {
  return (
    cache.last_miss_at !== undefined &&
    cache.last_miss_at !== null &&
    nowSeconds - cache.last_miss_at <= RECENT_MISS_WINDOW_SECONDS
  );
}

/** Short lower-case word for each documented miss cause. */
const MISS_CAUSE_WORDS: Record<string, string> = {
  tools_changed: 'tools',
  system_prompt_changed: 'system',
  ttl_expired_5m: 'ttl5m',
  ttl_expired_1h: 'ttl1h',
  likely_server_side: 'server',
};

/** At most this many cause words are shown, to keep the segment compact. */
const MAX_CAUSE_WORDS = 2;

/** Time left on the cache: `<1m`, `Nm` under an hour, `NhMMm` from an hour. Minutes are floored. */
export function formatCacheTtl(remainingSeconds: number): string {
  if (!Number.isFinite(remainingSeconds)) return '';
  const seconds = Math.floor(remainingSeconds);
  if (seconds < 60) return '<1m';
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${String(totalMinutes % 60).padStart(2, '0')}m`;
}

/** Short word for a miss cause; unknown names lose a "likely_" prefix and keep only safe characters. */
function missCauseWord(cause: string): string {
  const known = MISS_CAUSE_WORDS[cause];
  if (known) return known;
  const ttl = /^ttl_expired_(\w+)$/.exec(cause);
  if (ttl) return `ttl${ttl[1]}`.toLowerCase().slice(0, 16);
  return cause.replace(/^likely_/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}

function missCauseSuffix(cache: StatuslinePromptCache, nowSeconds: number): string {
  const causes = cache.last_miss_cause?.causes;
  if (!causes || causes.length === 0 || cache.last_miss_at === undefined || cache.last_miss_at === null) return '';
  const age = nowSeconds - cache.last_miss_at;
  if (age > RECENT_MISS_WINDOW_SECONDS || age < -5) return '';
  const words = [...new Set(causes.map(missCauseWord).filter((w) => w.length > 0))].slice(0, MAX_CAUSE_WORDS);
  return words.length > 0 ? `(${words.join('+')})` : '';
}

function turnTotal(turn: PromptCacheTurn): number {
  return turn.inputTokens + turn.cacheCreationTokens + turn.cacheReadTokens;
}

function renderOfficialPromptCache(
  usage: PromptCacheUsage | null | undefined,
  labels: Pick<HudLabels, 'cache'>,
  official: OfficialPromptCache,
  now: number,
): string {
  const { cache } = official;
  const nowSeconds = now / 1000;
  const parts: string[] = [];

  // Floor, so 100% means every input token was read from the cache.
  const percent =
    cache.hit_ratio !== undefined && cache.hit_ratio !== null
      ? `${Math.min(100, Math.floor(cache.hit_ratio * 100 + 1e-9))}%`
      : null;
  const misses = cache.misses !== undefined && cache.misses > 0 ? yellow(`miss:${cache.misses}`) : null;
  const remaining = remainingSecondsOf(cache, nowSeconds);

  // Cold: Claude Code says so, or the reported expiry has passed. The next request re-caches the prompt.
  if (cache.warm === false || (remaining !== null && remaining <= 0)) {
    parts.push(yellow(`${labels.cache}:COLD`));
    if (cache.recache_tokens_if_cold !== undefined && cache.recache_tokens_if_cold !== null) {
      parts.push(`rebuild~${formatTokenCount(cache.recache_tokens_if_cold)}`);
    }
    if (percent) parts.push(percent);
    if (misses) parts.push(misses);
    return parts.join(' ');
  }

  // Latest request counts: current_usage first, the transcript's last turn otherwise.
  const transcriptLast = usage && usage.turns >= 1 ? usage.last : null;
  const fromStdin = official.currentUsage && turnTotal(official.currentUsage) > 0 ? official.currentUsage : null;
  const fromTranscript = transcriptLast && turnTotal(transcriptLast) > 0 ? transcriptLast : null;
  const last = fromStdin ?? fromTranscript;

  let head = `${labels.cache}:`;
  let marker: string | null = null;
  if (last) {
    const counts = `${labels.cache}:w${formatTokenCount(last.cacheCreationTokens)}/r${formatTokenCount(last.cacheReadTokens)}`;
    const firstRequest =
      cache.requests !== undefined ? cache.requests === 1 : Boolean(usage?.complete && usage.turns === 1);

    // Prompt size of the request before `last`. The transcript can trail the stdin by one request:
    // then its latest request is the previous one; when both agree its own previous-prompt size applies.
    let previousPromptTokens: number | undefined;
    if (usage) {
      const sameRequest =
        transcriptLast !== null &&
        transcriptLast.cacheCreationTokens === last.cacheCreationTokens &&
        transcriptLast.cacheReadTokens === last.cacheReadTokens;
      previousPromptTokens =
        sameRequest || last === fromTranscript
          ? usage.previousPromptTokens
          : transcriptLast
            ? turnTotal(transcriptLast)
            : undefined;
    }
    const readCollapsed =
      last.cacheReadTokens === 0 ||
      (previousPromptTokens !== undefined &&
        last.cacheReadTokens < MISS_READ_SHARE_OF_PREVIOUS_PROMPT * previousPromptTokens);

    if (firstRequest) {
      head = yellow(counts);
      marker = 'new';
    } else if (readCollapsed && last.cacheCreationTokens >= PROMPT_CACHE_MISS_MIN_WRITE_TOKENS) {
      // Claude Code counts compactions and cleared tool results as expected rebuilds, not misses:
      // when its miss data says nothing recent, the rebuild is neutral, not a red MISS.
      if (hasOfficialMissData(cache) && !officialMissIsRecent(cache, nowSeconds)) {
        head = yellow(counts);
        marker = yellow('rebuild');
      } else {
        head = red(counts);
        marker = red(`MISS${missCauseSuffix(cache, nowSeconds)}`);
      }
    } else {
      const lastRate = hitRate(last.cacheReadTokens, last.cacheCreationTokens, last.inputTokens);
      head = lastRate >= HIT_RATE_THRESHOLD ? green(counts) : yellow(counts);
    }
  }

  parts.push(head);
  if (marker) parts.push(marker);
  if (percent) parts.push(percent);
  if (misses) parts.push(misses);
  if (remaining !== null) {
    const ttl = formatCacheTtl(remaining);
    if (ttl) parts.push(`ttl:${ttl}`);
  }

  // Without any count the head is a bare label: attach the first value so the segment reads cache:99%.
  if (!last) {
    const rest = parts.slice(1);
    return rest.length > 0 ? `${labels.cache}:${rest.join(' ')}` : '';
  }
  return parts.join(' ');
}

/**
 * Render the prompt-cache segment. `official` is the parsed statusline
 * `prompt_cache` (see parseOfficialPromptCache); without it the transcript
 * `usage` alone drives the output, as before. `now` is epoch milliseconds,
 * injectable for deterministic tests.
 */
export function renderPromptCache(
  usage: PromptCacheUsage | null | undefined,
  labels: Pick<HudLabels, 'cache'> = DEFAULT_HUD_LABELS,
  official?: OfficialPromptCache | null,
  now: number = Date.now(),
): string | null {
  if (official) {
    const rendered = renderOfficialPromptCache(usage, labels, official, now);
    if (rendered) return rendered;
  }
  return renderTranscriptPromptCache(usage, labels);
}

function renderTranscriptPromptCache(
  usage: PromptCacheUsage | null | undefined,
  labels: Pick<HudLabels, 'cache'>,
): string | null {
  if (!usage || usage.turns < 1) return null;

  const { last, session } = usage;
  const lastTotal = last.inputTokens + last.cacheCreationTokens + last.cacheReadTokens;
  if (lastTotal <= 0) return null;

  const counts = `${labels.cache}:w${formatTokenCount(last.cacheCreationTokens)}/r${formatTokenCount(last.cacheReadTokens)}`;

  // First request of a session writes the cache and reads nothing by design.
  // Only a transcript read from its start can tell it is the first request.
  if (usage.complete && usage.turns === 1) {
    return `${yellow(counts)} new`;
  }

  const sessionPercent = Math.round(
    hitRate(session.cacheReadTokens, session.cacheCreationTokens, session.inputTokens) * 100,
  );
  const sessionPart = `s${sessionPercent}%`;

  // Without a previous request (tail-read transcript) only a zero read can be told apart.
  const readCollapsed =
    last.cacheReadTokens === 0 ||
    (usage.previousPromptTokens !== undefined &&
      last.cacheReadTokens < MISS_READ_SHARE_OF_PREVIOUS_PROMPT * usage.previousPromptTokens);

  if (readCollapsed && last.cacheCreationTokens >= PROMPT_CACHE_MISS_MIN_WRITE_TOKENS) {
    return `${red(counts)} ${red('MISS')} ${sessionPart}`;
  }

  const lastRate = hitRate(last.cacheReadTokens, last.cacheCreationTokens, last.inputTokens);
  const colored = lastRate >= HIT_RATE_THRESHOLD ? green(counts) : yellow(counts);
  return `${colored} ${sessionPart}`;
}
