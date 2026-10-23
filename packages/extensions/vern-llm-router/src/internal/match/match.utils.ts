import type { ContextMatch, RouteConditions, RouteWhen } from '../../types/index.js';
import type { RequestFacts } from './requestFacts.utils.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

function contextMatches(actual: unknown, wanted: ContextMatch): boolean {
  return Array.isArray(wanted) ? wanted.some((value) => value === actual) : actual === wanted;
}

function conditionsMatch(
  when: RouteConditions,
  ctx: PreDispatchContext,
  facts: RequestFacts,
): boolean {
  for (const [key, wanted] of Object.entries(when.context ?? {})) {
    const context = ctx.context;
    if (!context || !Object.hasOwn(context, key) || !contextMatches(context[key], wanted)) {
      return false;
    }
  }
  if (when.hasTools !== undefined && when.hasTools !== facts.hasTools) return false;
  if (when.jsonOutput !== undefined && when.jsonOutput !== facts.jsonOutput) return false;
  if (when.minInputTokens !== undefined && facts.inputTokens < when.minInputTokens) return false;
  if (when.maxInputTokens !== undefined && facts.inputTokens > when.maxInputTokens) return false;
  return true;
}

/** Whether a route applies. A function that throws propagates, so the caller can fail open. */
export function routeMatches(
  when: RouteWhen | undefined,
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
  facts: RequestFacts,
): boolean {
  if (when === undefined) return true;
  if (typeof when === 'function') return when(ctx, request) === true;
  return conditionsMatch(when, ctx, facts);
}
