import { LLMError, type VernLLMEvent } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { TargetState } from '../../../src/internal/targetState.js';
import { trackEvent } from '../../../src/internal/trackEvent.utils.js';

const limited = (retryAfterMs?: number) =>
  new LLMError('429', 'rate_limited', { code: 'provider_rate_limited', retryAfterMs });
const other = () => new LLMError('500', 'api', { code: 'provider_server_error' as never });

describe('trackEvent', () => {
  it('cools the provider down on a rate limited retry, for its Retry-After', () => {
    const state = new TargetState(1000);
    trackEvent(state, { kind: 'retry', provider: 'a', error: limited(2_000) } as VernLLMEvent, 0);
    expect(state.read('a', 1_999).cooling).toBe(true);
    expect(state.read('a', 2_000).cooling).toBe(false);
  });

  it('cools down the target a rate limited fallback came from', () => {
    const state = new TargetState(1000);
    trackEvent(
      state,
      { kind: 'fallback', from: 'a', to: 'b', error: limited() } as VernLLMEvent,
      0,
    );
    expect(state.read('a', 0).cooling).toBe(true);
    expect(state.read('b', 0).cooling).toBe(false);
  });

  it('ignores errors that are not rate limits', () => {
    const state = new TargetState(1000);
    trackEvent(state, { kind: 'retry', provider: 'a', error: other() } as VernLLMEvent, 0);
    trackEvent(state, { kind: 'fallback', from: 'a', to: 'b', error: other() } as VernLLMEvent, 0);
    expect(state.size).toBe(0);
  });

  it('starts warming when a circuit closes, but not on a transition to open or half open', () => {
    const state = new TargetState(1000);
    const transition = (provider: string, from: string, to: string) =>
      trackEvent(state, { kind: 'circuit_state', provider, from, to } as VernLLMEvent, 0);

    transition('a', 'half-open', 'closed');
    transition('b', 'closed', 'open');
    transition('c', 'open', 'half-open');
    transition('d', 'closed', 'closed');

    expect(state.read('a', 0).warmingFactor).toBeCloseTo(0.1);
    expect(state.read('b', 0).warmingFactor).toBe(1);
    expect(state.read('c', 0).warmingFactor).toBe(1);
    expect(state.read('d', 0).warmingFactor).toBe(1);
  });

  it('ignores custom data that is not an object with a target', () => {
    const state = new TargetState(1000);
    const rules = [{ event: 'x', when: [], holdMs: 1_000 }];
    for (const data of [undefined, null, 'a', ['a'], { target: 1 }]) {
      trackEvent(state, { kind: 'custom', name: 'x', data } as VernLLMEvent, 0, rules);
    }
    expect(state.size).toBe(0);
  });

  it('holds back the named target for a matching custom event, for at most a minute', () => {
    const state = new TargetState(1000);
    const rules = [{ event: 'x', when: [['kind', 'slow']] as const, holdMs: 1_000 }];
    trackEvent(
      state,
      { kind: 'custom', name: 'x', data: { target: 'a', kind: 'slow' } } as never,
      0,
      rules,
    );
    expect(state.read('a', 999).cooling).toBe(true);
    expect(state.read('a', 1_000).cooling).toBe(false);

    state.holdBack('b', 10 * 60_000, 0);
    expect(state.read('b', 59_999).cooling).toBe(true);
    expect(state.read('b', 60_000).cooling).toBe(false);
  });

  it('ignores other events', () => {
    const state = new TargetState(1000);
    trackEvent(state, { kind: 'custom', name: 'x' } as VernLLMEvent);
    expect(state.size).toBe(0);
  });
});
