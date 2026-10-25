import { describe, expect, it } from 'vitest';

import { createMemo } from '../../../../src/internal/scan/memo.utils.js';

describe('createMemo', () => {
  it('is off at zero', () => {
    expect(createMemo(0)).toBeUndefined();
  });

  it('drops the least recently used entry first', () => {
    const memo = createMemo(2)!;
    memo.set('a', []);
    memo.set('b', []);
    memo.get('a');
    memo.set('c', []);

    expect(memo.get('b')).toBeUndefined();
    expect(memo.get('a')).toEqual([]);
    expect(memo.get('c')).toEqual([]);
    expect(memo.size).toBe(2);
  });
});
