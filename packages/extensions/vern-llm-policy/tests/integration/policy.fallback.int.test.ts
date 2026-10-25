import { isFallbackExhaustedError, isLLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { harness, serverError, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

describe('fallback', () => {
  it('skips a forbidden target in the middle of the chain', async () => {
    const { llm, tried } = harness(
      { rules: [{ id: 'no-b', forbid: { name: 'b' } }] },
      { primary: [serverError()] },
    );

    expect(await llm.call(call)).toBe('c');

    expect(tried()).toEqual(['primary', 'c']);
  });

  it('fails when the only allowed target fails, without trying a forbidden one', async () => {
    const { llm, tried } = harness(
      { rules: [{ id: 'primary-only', allow: { name: 'primary' } }] },
      { primary: [serverError()], b: [textResponse('b')], c: [textResponse('c')] },
    );

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(isLLMError(error)).toBe(true);
    expect(tried()).toEqual(['primary']);
  });

  it('reports only the allowed targets when the whole chain fails', async () => {
    const { llm, tried } = harness(
      { rules: [{ id: 'no-b', forbid: { name: 'b' } }] },
      { primary: [serverError()], c: [serverError()] },
    );

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(isFallbackExhaustedError(error)).toBe(true);
    if (isFallbackExhaustedError(error)) {
      expect(error.attempts.map((attempt) => attempt.provider)).toEqual(['primary', 'c']);
    }
    expect(tried()).toEqual(['primary', 'c']);
  });

  it('retries a target in place before falling back, and never reaches a forbidden one', async () => {
    const { llm, tried } = harness(
      { rules: [{ id: 'no-b', forbid: { name: 'b' } }] },
      { primary: [serverError(), serverError(), serverError()], c: [textResponse('c')] },
      { maxRetries: 2, baseDelayMs: 1 },
    );

    expect(await llm.call(call)).toBe('c');

    expect(tried()).toEqual(['primary', 'primary', 'primary', 'c']);
  });
});
