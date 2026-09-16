import { describe, expect, it } from 'vitest';

import {
  bucketKey,
  modelFromKey,
} from '../../../../src/internal/circuit-breaker/bucketKey.utils.js';

describe('bucketKey', () => {
  it('returns the bare prefix when isolateByModel is false, regardless of model', () => {
    expect(bucketKey('cb', false, 'gpt-4o')).toBe('cb');
    expect(bucketKey('cb', false, undefined)).toBe('cb');
  });

  it('suffixes the prefix with the model when isolateByModel is true', () => {
    expect(bucketKey('cb', true, 'gpt-4o')).toBe('cb:gpt-4o');
  });

  it('suffixes with "default" when isolateByModel is true but model is undefined', () => {
    expect(bucketKey('cb', true, undefined)).toBe('cb:default');
  });
});

describe('modelFromKey', () => {
  it('always returns undefined when isolateByModel is false, regardless of the key', () => {
    expect(modelFromKey('cb', 'cb', false)).toBeUndefined();
    expect(modelFromKey('cb:gpt-4o', 'cb', false)).toBeUndefined();
  });

  it('recovers the model from a key built with the same prefix', () => {
    expect(modelFromKey('cb:gpt-4o', 'cb', true)).toBe('gpt-4o');
  });

  it('maps the "default" suffix back to undefined', () => {
    expect(modelFromKey('cb:default', 'cb', true)).toBeUndefined();
  });

  it('round trips through bucketKey for an arbitrary model', () => {
    const key = bucketKey('vernllm:cb', true, 'claude-3-opus');
    expect(modelFromKey(key, 'vernllm:cb', true)).toBe('claude-3-opus');
  });

  it('round trips through bucketKey for an undefined model', () => {
    const key = bucketKey('vernllm:cb', true, undefined);
    expect(modelFromKey(key, 'vernllm:cb', true)).toBeUndefined();
  });
});
