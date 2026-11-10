/**
 * OMC HUD - Prompt Cache Element
 *
 * Renders prompt-cache activity from transcript message.usage: tokens written
 * to the cache and read from it by the latest request, plus the session hit
 * rate. A rebuilt cache (large write, zero read, after the first request) is
 * marked MISS in text so the signal does not depend on colour.
 *
 * Format: cache:w1.2k/r45.0k s97%      (hit or partial)
 * Format: cache:w21.0k/r0 new          (first request of a session, not a miss)
 * Format: cache:w48.0k/r0 MISS s83%    (cache rebuilt: expired or invalidated)
 */

import type { HudLabels, PromptCacheUsage } from '../types.js';
import { DEFAULT_HUD_LABELS } from '../types.js';
import { formatTokenCount } from '../../cli/utils/formatting.js';
import { green, yellow, red } from '../colors.js';

/**
 * A latest request counts as a rebuilt cache when it wrote at least this many
 * tokens and read none. 4096 is the largest minimum cacheable prompt length of
 * any Claude model, so a smaller write is ordinary new content, not a rebuild.
 */
export const PROMPT_CACHE_MISS_MIN_WRITE_TOKENS = 4096;

/** Latest-request hit rate at or above which the cache counts as a hit (green). */
const HIT_RATE_THRESHOLD = 0.8;

function hitRate(read: number, written: number, uncached: number): number {
  const total = read + written + uncached;
  return total > 0 ? read / total : 0;
}

export function renderPromptCache(
  usage: PromptCacheUsage | null | undefined,
  labels: Pick<HudLabels, 'cache'> = DEFAULT_HUD_LABELS,
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

  if (
    last.cacheReadTokens === 0 &&
    last.cacheCreationTokens >= PROMPT_CACHE_MISS_MIN_WRITE_TOKENS
  ) {
    return `${red(counts)} ${red('MISS')} ${sessionPart}`;
  }

  const lastRate = hitRate(last.cacheReadTokens, last.cacheCreationTokens, last.inputTokens);
  const colored = lastRate >= HIT_RATE_THRESHOLD ? green(counts) : yellow(counts);
  return `${colored} ${sessionPart}`;
}
