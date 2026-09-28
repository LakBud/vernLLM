import { describe, expect, it } from 'vitest';

import { createLocalCircuitCache } from '../../../../../src/internal/circuit-breaker/state/localCache.utils.js';
import {
  applyObservation,
  type Observation,
} from '../../../../../src/internal/circuit-breaker/state/observe.utils.js';

const seen = (over: Partial<Observation>): Observation => ({
  state: 'closed',
  failures: 0,
  openedAt: 0,
  version: 1,
  ...over,
});

describe('applyObservation', () => {
  it('reports a newer change once, and the same version again not at all', () => {
    const local = createLocalCircuitCache();
    const opened = seen({ from: 'closed', state: 'open', failures: 5, version: 10 });

    expect(applyObservation(local, 'k', opened)).toEqual({
      from: 'closed',
      to: 'open',
      failures: 5,
    });
    expect(applyObservation(local, 'k', opened)).toBeUndefined();
    expect(local.get('k').version).toBe(10);
  });

  it('drops an older observation whole, unless forced', () => {
    const local = createLocalCircuitCache();
    applyObservation(local, 'k', seen({ state: 'open', version: 10 }));

    expect(applyObservation(local, 'k', seen({ state: 'closed', version: 9 }))).toBeUndefined();
    expect(local.get('k').state).toBe('open');

    expect(applyObservation(local, 'k', seen({ state: 'closed', version: 0 }), true)).toEqual({
      from: 'open',
      to: 'closed',
      failures: 0,
    });
    expect(local.get('k').version).toBe(10);
  });

  it('catches up from what it last knew when the observation is not the change itself', () => {
    const local = createLocalCircuitCache();
    applyObservation(local, 'k', seen({ state: 'open', version: 10 }));

    expect(
      applyObservation(local, 'k', seen({ from: 'closed', state: 'closed', version: 12 })),
    ).toEqual({ from: 'open', to: 'closed', failures: 0 });
  });

  it('adds won slots of one epoch, and drops held slots when the epoch moves on', () => {
    const local = createLocalCircuitCache();
    const halfOpen = { state: 'half-open' as const, version: 20 };

    applyObservation(local, 'k', seen({ ...halfOpen, wonToken: '7' }));
    applyObservation(local, 'k', seen({ ...halfOpen, wonToken: '7' }));
    expect(local.get('k')).toMatchObject({ trialsHeld: 2, trialToken: '7' });

    applyObservation(local, 'k', seen({ ...halfOpen, epoch: '7' }));
    expect(local.get('k').trialsHeld).toBe(2);

    applyObservation(local, 'k', seen({ ...halfOpen, epoch: '8' }));
    expect(local.get('k')).toMatchObject({ trialsHeld: 0, trialToken: '' });
  });

  it('keeps timing and breakdown it already had when an observation carries none', () => {
    const local = createLocalCircuitCache();
    applyObservation(
      local,
      'k',
      seen({
        version: 1,
        breakdown: { rate_limited: 2 },
        timing: { serverNow: Date.now(), cooldownMs: 500, slots: 1, grantAt: 3 },
      }),
    );

    applyObservation(local, 'k', seen({ version: 2 }));

    expect(local.get('k')).toMatchObject({
      breakdown: { rate_limited: 2 },
      cooldownMs: 500,
      slots: 1,
      grantAt: 3,
    });
  });
});
