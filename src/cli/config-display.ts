/**
 * Helpers for `omc config` output: secret redaction and validation warnings.
 */

const SENSITIVE_KEY = /api[-_]?key|token|secret|password|webhook/i;

export const REDACTED = '[REDACTED]';

/**
 * Return a deep copy of `value` with every sensitive value replaced by
 * "[REDACTED]". A key is sensitive when it matches apiKey/token/secret/
 * password/webhook (case-insensitive). Strings, objects and arrays under such a
 * key are fully redacted; empty strings, numbers, booleans and null are kept so
 * the output still shows whether a setting is unset or a plain limit.
 */
export function redactSensitiveConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveConfig(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        const keep =
          child === null ||
          child === undefined ||
          child === '' ||
          typeof child === 'number' ||
          typeof child === 'boolean';
        result[key] = keep ? child : REDACTED;
      } else {
        result[key] = redactSensitiveConfig(child);
      }
    }
    return result;
  }
  return value;
}

const PROVIDER_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
] as const;

/** Provider flags count as on only for "1" or "true" (case-insensitive). */
function isEnabledFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

export interface ValidationConfigView {
  mcpServers?: { exa?: { enabled?: boolean; apiKey?: string } };
}

/**
 * Non-fatal findings for `omc config --validate`.
 *
 * Anthropic credentials are only reported missing when no supported source is
 * present: an API key, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, a
 * Bedrock/Vertex provider, or an existing Claude subscription login.
 */
export function getConfigWarnings(
  config: ValidationConfigView,
  env: NodeJS.ProcessEnv,
  hasClaudeLogin: boolean,
): string[] {
  const warnings: string[] = [];

  const hasAuth =
    hasClaudeLogin ||
    Boolean(env.ANTHROPIC_API_KEY) ||
    Boolean(env.ANTHROPIC_AUTH_TOKEN) ||
    Boolean(env.CLAUDE_CODE_OAUTH_TOKEN) ||
    PROVIDER_FLAGS.some((flag) => isEnabledFlag(env[flag]));
  if (!hasAuth) {
    warnings.push(
      'No Claude authentication found: sign in with `claude` (subscription login) or set one of ' +
        'CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY',
    );
  }

  if (config.mcpServers?.exa?.enabled && !env.EXA_API_KEY && !config.mcpServers.exa.apiKey) {
    warnings.push('Exa is enabled but EXA_API_KEY is not set');
  }

  return warnings;
}
