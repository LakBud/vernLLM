import type { ResolvedHoldBack } from '../types/index.js';
import type { TargetState } from './targetState.js';
import type { VernLLMEvent } from 'vern-llm';

type CustomEvent = Extract<VernLLMEvent, { kind: 'custom' }>;

/** Holds back the target a matching custom event names. */
function holdBackFor(
  state: TargetState,
  event: CustomEvent,
  now: number,
  rules: readonly ResolvedHoldBack[],
): void {
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  if (typeof data['target'] !== 'string') return;

  for (const rule of rules) {
    if (rule.event === event.name && rule.when.every(([field, value]) => data[field] === value)) {
      state.holdBack(data['target'], rule.holdMs, now);
    }
  }
}

/** A provider 429 cools a target down; a breaker closing after being open starts warming. */
export function trackEvent(
  state: TargetState,
  event: VernLLMEvent,
  now = Date.now(),
  holdBack: readonly ResolvedHoldBack[] = [],
): void {
  if (event.kind === 'custom') {
    holdBackFor(state, event, now, holdBack);
  } else if (event.kind === 'retry' && event.error.code === 'provider_rate_limited') {
    state.rateLimited(event.provider, event.error.retryAfterMs, now);
  } else if (event.kind === 'fallback' && event.error.code === 'provider_rate_limited') {
    state.rateLimited(event.from, event.error.retryAfterMs, now);
  } else if (event.kind === 'circuit_state' && event.to === 'closed' && event.from !== 'closed') {
    state.recovered(event.provider, now);
  }
}
