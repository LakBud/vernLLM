import { describe, it, expect } from 'vitest';

import {
  canonicalStringify,
  deriveCacheKeyFromRequest,
} from '../../../../../src/internal/cache/utils/deriveCacheKey.utils.js';

describe('canonicalStringify', () => {
  it('sorts object keys so insertion order does not affect the output', () => {
    const a = canonicalStringify({ b: 1, a: 2 });
    const b = canonicalStringify({ a: 2, b: 1 });

    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('stringifies a top-level undefined value directly', () => {
    expect(canonicalStringify(undefined)).toBe('undefined');
  });

  it('stringifies undefined found inside an array, instead of dropping it', () => {
    expect(canonicalStringify([1, undefined, 2])).toBe('[1,undefined,2]');
  });

  it('omits a key whose value is undefined, matching JSON.stringify', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('stringifies primitives and null the same as JSON.stringify', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify('x')).toBe('"x"');
    expect(canonicalStringify(1)).toBe('1');
    expect(canonicalStringify(true)).toBe('true');
  });

  it('recurses into nested objects and arrays', () => {
    expect(canonicalStringify({ b: [2, 1], a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":[2,1]}',
    );
  });
});

describe('deriveCacheKeyFromRequest', () => {
  it('produces a wr_-prefixed, fixed-length hex key', () => {
    const key = deriveCacheKeyFromRequest({ model: 'm', request: { a: 1 } });
    expect(key).toMatch(/^wr_[0-9a-f]{8}$/);
  });

  it('is a pure function: same input derives the same key', () => {
    const a = deriveCacheKeyFromRequest({ model: 'm', request: { a: 1, b: 2 } });
    const b = deriveCacheKeyFromRequest({ model: 'm', request: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('changes when the request differs', () => {
    const a = deriveCacheKeyFromRequest({ model: 'm', request: { a: 1 } });
    const b = deriveCacheKeyFromRequest({ model: 'm', request: { a: 2 } });
    expect(a).not.toBe(b);
  });

  it('changes when the model differs', () => {
    const a = deriveCacheKeyFromRequest({ model: 'm1', request: { a: 1 } });
    const b = deriveCacheKeyFromRequest({ model: 'm2', request: { a: 1 } });
    expect(a).not.toBe(b);
  });
});
