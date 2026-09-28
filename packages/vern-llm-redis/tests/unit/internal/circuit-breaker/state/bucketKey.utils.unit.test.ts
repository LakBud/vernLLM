import { describe, expect, it } from 'vitest';

import {
  bucketKey,
  escapeGlob,
  modelFromKey,
} from '../../../../../src/internal/circuit-breaker/state/bucketKey.utils.js';

describe('bucketKey', () => {
  it('returns the bare prefix when isolateByModel is false, regardless of model', () => {
    expect(bucketKey('cb', false, 'gpt-4o')).toBe('cb');
    expect(bucketKey('cb', false, undefined)).toBe('cb');
  });

  it('suffixes the prefix with the model when isolateByModel is true', () => {
    expect(bucketKey('cb', true, 'gpt-4o')).toBe('cb:gpt-4o');
  });

  it('keeps the bare prefix for a call with no model, a key no model name can produce', () => {
    expect(bucketKey('cb', true, undefined)).toBe('cb');
  });

  it('gives a model named "default" its own key, apart from the no model bucket', () => {
    expect(bucketKey('cb', true, 'default')).toBe('cb:default');
    expect(bucketKey('cb', true, 'default')).not.toBe(bucketKey('cb', true, undefined));
  });

  it('keeps an empty model name apart from no model', () => {
    expect(bucketKey('cb', true, '')).toBe('cb:');
  });
});

describe('escapeGlob', () => {
  it('escapes every character SCAN treats as a glob', () => {
    expect(escapeGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f');
  });

  it('leaves an ordinary prefix alone', () => {
    expect(escapeGlob('vernllm:cb')).toBe('vernllm:cb');
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

  it('maps the bare prefix back to undefined and a "default" suffix to that model', () => {
    expect(modelFromKey('cb', 'cb', true)).toBeUndefined();
    expect(modelFromKey('cb:default', 'cb', true)).toBe('default');
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
