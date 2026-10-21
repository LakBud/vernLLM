import type { Enricher, JsonValue, UsageFields } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PreDispatchContext, TokenUsage } from 'vern-llm';

/** The allowlisted `context` keys, and only those. `undefined` when none are present. */
export function pickContext(
  context: PreDispatchContext['context'],
  allowed: readonly string[],
): Record<string, JsonValue> | undefined {
  if (!context || allowed.length === 0) return undefined;

  const picked: Record<string, JsonValue> = {};
  for (const key of allowed) {
    if (Object.hasOwn(context, key) && context[key] !== undefined) picked[key] = context[key];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** Runs each enricher on its own guard and merges the results left to right. */
export function runEnrichers(
  enrichers: readonly Enricher[],
  ctx: PreDispatchContext,
  guard: Guard,
): Record<string, JsonValue> | undefined {
  if (enrichers.length === 0) return undefined;

  const merged: Record<string, JsonValue> = {};
  enrichers.forEach((enrich, index) => {
    const operation = `enrich[${index}]`;
    const fields: unknown = guard(operation, () => enrich(ctx), undefined);
    if (typeof fields !== 'object' || fields === null) return;

    // An async enricher cannot be waited for, so its rejection is reported.
    if (typeof (fields as { then?: unknown }).then === 'function') {
      Promise.resolve(fields).catch((error: unknown) => guard.report(operation, error));
      return;
    }

    for (const [key, value] of Object.entries(fields)) {
      // `__proto__` would change the record's prototype instead of adding a field.
      if (key !== '__proto__') merged[key] = value as JsonValue;
    }
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** The token counts of a usage object, copied field by field so nothing else leaks. */
export function pickUsage(usage: TokenUsage): UsageFields {
  const picked: UsageFields = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
  if (isCount(usage.reasoningTokens)) picked.reasoningTokens = usage.reasoningTokens;
  if (isCount(usage.cacheReadTokens)) picked.cacheReadTokens = usage.cacheReadTokens;
  if (isCount(usage.cacheWriteTokens)) picked.cacheWriteTokens = usage.cacheWriteTokens;

  if (usage.cacheWriteTokensByTtl) {
    const byTtl: Record<string, number> = {};
    for (const [ttl, tokens] of Object.entries(usage.cacheWriteTokensByTtl)) {
      if (ttl !== '__proto__' && isCount(tokens)) byTtl[ttl] = tokens;
    }
    picked.cacheWriteTokensByTtl = byTtl;
  }
  return picked;
}
