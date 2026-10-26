import { describe, expect, it } from 'vitest';

import { bucketOfRequest, bucketOfTokens } from '../../../src/internal/size.utils.js';

import type { WireCallRequest } from 'vern-llm';

function request(chars: number, maxTokens = 4_096): WireCallRequest {
  return {
    model: 'm',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: 'x'.repeat(chars) }],
  };
}

describe('bucketOfTokens', () => {
  it.each([
    [0, 'xs'],
    [999, 'xs'],
    [1_000, 's'],
    [3_999, 's'],
    [4_000, 'm'],
    [15_999, 'm'],
    [16_000, 'l'],
    [63_999, 'l'],
    [64_000, 'xl'],
    [1_000_000, 'xl'],
  ])('puts %i tokens in %s', (tokens, bucket) => {
    expect(bucketOfTokens(tokens)).toBe(bucket);
  });
});

describe('bucketOfRequest', () => {
  it('leaves out the tokens reserved for the answer', () => {
    // About 100 prompt tokens. With 4096 reserved for the answer it would read as `m`.
    expect(bucketOfRequest(request(400, 4_096))).toBe('xs');
  });

  it('reads a request with no max_tokens as having reserved nothing', () => {
    const { max_tokens: _omitted, ...bare } = request(8_000);

    expect(bucketOfRequest(bare as WireCallRequest)).toBe('s');
  });

  it('does not go below the first bucket for an empty prompt', () => {
    expect(bucketOfRequest(request(0, 8_000))).toBe('xs');
  });

  it.each([2_000, 8_000, 40_000, 120_000, 500_000])(
    'lands a %i character prompt where its recorded token count lands',
    (chars) => {
      // Providers usually count somewhat fewer tokens than characters / 4.
      const recorded = Math.round((chars / 4) * 0.9);

      expect(bucketOfRequest(request(chars))).toBe(bucketOfTokens(recorded));
    },
  );
});
