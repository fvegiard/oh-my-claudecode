/**
 * OMC HUD - official prompt-cache stdin parser
 *
 * Kept apart from the renderer (type-only imports) so the HUD entry point can
 * parse the statusline stdin without loading the renderer's runtime graph.
 */

import type { OfficialPromptCache, StatuslinePromptCache } from './types.js';

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** A count: a non-negative integer a counter can hold exactly. */
function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the official `prompt_cache` object (and the latest request's
 * context_window.current_usage) from the statusline stdin. Never throws:
 * a missing, non-object or wrong-typed value is treated as absent, unknown keys
 * are ignored. Returns null when there is no prompt_cache object or nothing
 * recognisable in it, and when Claude Code reports caching_observed false
 * (prompt caching off or not reported), so callers fall back to the transcript.
 */
export function parseOfficialPromptCache(stdin: unknown): OfficialPromptCache | null {
  try {
    if (!isRecord(stdin) || !isRecord(stdin.prompt_cache)) return null;
    const raw = stdin.prompt_cache;
    if (raw.caching_observed === false) return null;

    const cache: StatuslinePromptCache = {};
    if (typeof raw.warm === 'boolean') cache.warm = raw.warm;
    if (typeof raw.caching_observed === 'boolean') cache.caching_observed = raw.caching_observed;
    if (typeof raw.ttl === 'string') cache.ttl = raw.ttl;
    const expiresAt = nonNegative(raw.expires_at);
    if (expiresAt !== undefined) cache.expires_at = expiresAt;
    const requests = safeCount(raw.requests);
    if (requests !== undefined) cache.requests = requests;
    const misses = safeCount(raw.misses);
    if (misses !== undefined) cache.misses = misses;
    const rebuilds = safeCount(raw.expected_rebuilds);
    if (rebuilds !== undefined) cache.expected_rebuilds = rebuilds;
    const ratio = finiteNumber(raw.hit_ratio);
    if (ratio !== undefined && ratio >= 0 && ratio <= 1) cache.hit_ratio = ratio;
    const written = nonNegative(raw.cache_write_tokens);
    if (written !== undefined) cache.cache_write_tokens = written;
    const missTokens = nonNegative(raw.miss_recache_tokens);
    if (missTokens !== undefined) cache.miss_recache_tokens = missTokens;
    const lastMissAt = nonNegative(raw.last_miss_at);
    if (lastMissAt !== undefined) cache.last_miss_at = lastMissAt;
    const ifCold = nonNegative(raw.recache_tokens_if_cold);
    if (ifCold !== undefined) cache.recache_tokens_if_cold = ifCold;
    if (isRecord(raw.last_miss_cause) && Array.isArray(raw.last_miss_cause.causes)) {
      const causes = raw.last_miss_cause.causes.filter((c): c is string => typeof c === 'string' && c.length > 0);
      if (causes.length > 0) cache.last_miss_cause = { causes };
    }
    if (isRecord(raw.miss_causes)) {
      const counts: Record<string, number> = {};
      for (const [name, count] of Object.entries(raw.miss_causes)) {
        const n = nonNegative(count);
        if (n !== undefined) counts[name] = n;
      }
      cache.miss_causes = counts;
    }

    // Nothing the renderer reads: behave as if the object were absent.
    const usable =
      cache.warm !== undefined ||
      cache.expires_at !== undefined ||
      cache.hit_ratio !== undefined ||
      cache.misses !== undefined ||
      cache.recache_tokens_if_cold !== undefined;
    if (!usable) return null;

    const parsed: OfficialPromptCache = { cache };
    const usage = isRecord(stdin.context_window) ? stdin.context_window.current_usage : undefined;
    if (isRecord(usage)) {
      const creation = nonNegative(usage.cache_creation_input_tokens);
      const read = nonNegative(usage.cache_read_input_tokens);
      if (creation !== undefined && read !== undefined) {
        parsed.currentUsage = {
          inputTokens: nonNegative(usage.input_tokens) ?? 0,
          cacheCreationTokens: creation,
          cacheReadTokens: read,
        };
      }
    }
    return parsed;
  } catch {
    return null;
  }
}
