import { describe, expect, it } from 'vitest';

import { shouldKeep } from '../../../../src/internal/pipeline/sample.utils.js';

describe('shouldKeep', () => {
  it('keeps everything at 1 and nothing at 0', () => {
    expect(shouldKeep('req_1', 1)).toBe(true);
    expect(shouldKeep('req_1', 0)).toBe(false);
  });

  it('decides the same way every time for one request id', () => {
    const first = shouldKeep('req_stable', 0.5);

    for (let i = 0; i < 10; i++) expect(shouldKeep('req_stable', 0.5)).toBe(first);
  });

  it('keeps about the requested share', () => {
    let kept = 0;
    for (let i = 0; i < 20_000; i++) if (shouldKeep(`req_${i}_${i * 7919}`, 0.1)) kept++;

    expect(kept / 20_000).toBeGreaterThan(0.08);
    expect(kept / 20_000).toBeLessThan(0.12);
  });
});
