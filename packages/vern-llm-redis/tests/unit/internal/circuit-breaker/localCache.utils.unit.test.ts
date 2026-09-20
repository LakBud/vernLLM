import { describe, expect, it } from 'vitest';

import { createLocalCircuitCache } from '../../../../src/internal/circuit-breaker/localCache.utils.js';

describe('createLocalCircuitCache', () => {
  it('get() on a never-seen key creates and returns a fresh closed bucket', () => {
    const cache = createLocalCircuitCache();
    expect(cache.get('k')).toEqual({
      state: 'closed',
      failures: 0,
      openedAt: 0,
      trialsHeld: 0,
      trialToken: '',
      breakdown: {},
      serverOffset: 0,
      cooldownMs: 0,
      slots: 0,
      grantAt: 0,
    });
  });

  it('get() on a key returns the same object identity on repeated calls, not a fresh one each time', () => {
    const cache = createLocalCircuitCache();
    expect(cache.get('k')).toBe(cache.get('k'));
  });

  it('set() overwrites the bucket wholesale for that key', () => {
    const cache = createLocalCircuitCache();
    cache.set('k', {
      state: 'open',
      failures: 5,
      openedAt: 123,
      trialsHeld: 0,
      trialToken: '',
      breakdown: {},
      serverOffset: 0,
      cooldownMs: 0,
      slots: 0,
      grantAt: 0,
    });

    expect(cache.get('k')).toEqual({
      state: 'open',
      failures: 5,
      openedAt: 123,
      trialsHeld: 0,
      trialToken: '',
      breakdown: {},
      serverOffset: 0,
      cooldownMs: 0,
      slots: 0,
      grantAt: 0,
    });
  });

  it('set() on one key never affects another key\u2019s bucket', () => {
    const cache = createLocalCircuitCache();
    cache.set('a', {
      state: 'open',
      failures: 5,
      openedAt: 123,
      trialsHeld: 0,
      trialToken: '',
      breakdown: {},
      serverOffset: 0,
      cooldownMs: 0,
      slots: 0,
      grantAt: 0,
    });

    expect(cache.get('b')).toEqual({
      state: 'closed',
      failures: 0,
      openedAt: 0,
      trialsHeld: 0,
      trialToken: '',
      breakdown: {},
      serverOffset: 0,
      cooldownMs: 0,
      slots: 0,
      grantAt: 0,
    });
  });

  it('keys() lists only keys this cache has actually been asked about', () => {
    const cache = createLocalCircuitCache();
    cache.get('a');
    cache.set('b', {
      state: 'open',
      failures: 1,
      openedAt: 1,
      trialsHeld: 0,
      trialToken: '',
      breakdown: {},
      serverOffset: 0,
      cooldownMs: 0,
      slots: 0,
      grantAt: 0,
    });

    expect([...cache.keys()].sort()).toEqual(['a', 'b']);
  });

  it('keys() is empty for a cache that has never been touched', () => {
    const cache = createLocalCircuitCache();
    expect([...cache.keys()]).toEqual([]);
  });
});
