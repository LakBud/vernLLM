import type { TargetState } from './targetState.js';
import type { VernLLMEvent } from 'vern-llm';

/** A provider 429 cools a target down; a breaker closing after being open starts warming. */
export function trackEvent(state: TargetState, event: VernLLMEvent, now = Date.now()): void {
  if (event.kind === 'retry' && event.error.code === 'provider_rate_limited') {
    state.rateLimited(event.provider, event.error.retryAfterMs, now);
  } else if (event.kind === 'fallback' && event.error.code === 'provider_rate_limited') {
    state.rateLimited(event.from, event.error.retryAfterMs, now);
  } else if (event.kind === 'circuit_state' && event.to === 'closed' && event.from !== 'closed') {
    state.recovered(event.provider, now);
  }
}
