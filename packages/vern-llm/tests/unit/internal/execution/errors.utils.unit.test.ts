import { describe, it, expect } from 'vitest';

import { normalizeError } from '../../../../src/internal/execution/errors.utils.js';
import { LLMError } from '../../../../src/types/errors.js';

describe('normalizeError', () => {
  it('returns an aborted LLMError when the signal is already aborted, regardless of the error', () => {
    const controller = new AbortController();
    controller.abort();

    const result = normalizeError(new Error('boom'), controller.signal);

    expect(result).toBeInstanceOf(LLMError);
    expect(result.type).toBe('aborted');
  });

  it('passes an existing LLMError through unchanged', () => {
    const original = new LLMError('already normalized', 'validation');

    expect(normalizeError(original)).toBe(original);
  });

  it('tags an already-normalized LLMError carrying status 429 with code "provider_rate_limited"', () => {
    const original = new LLMError('rate limited', 'api', 429);

    const result = normalizeError(original);

    expect(result).toBe(original);
    expect(result.code).toBe('provider_rate_limited');
  });

  it('does not overwrite an existing code on an already-normalized 429 LLMError', () => {
    const original = new LLMError(
      'rate limited',
      'api',
      429,
      undefined,
      undefined,
      undefined,
      'local_rate_limit',
    );

    const result = normalizeError(original);

    expect(result.code).toBe('local_rate_limit');
  });

  it('does not add a code to an already-normalized LLMError with a non-429 status', () => {
    const original = new LLMError('server error', 'api', 500);

    const result = normalizeError(original);

    expect(result.code).toBeUndefined();
  });

  it('wraps an error carrying an http status as type "api" and preserves the status', () => {
    const result = normalizeError({ status: 500 });

    expect(result.type).toBe('api');
    expect(result.status).toBe(500);
  });

  it("falls back to AWS SDK v3's $metadata.httpStatusCode when status/statusCode are absent", () => {
    const result = normalizeError({
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
    });

    expect(result.type).toBe('api');
    expect(result.status).toBe(429);
  });

  it('carries a Retry-After value through onto the normalized error', () => {
    const err = {
      status: 429,
      headers: { get: (name: string) => (name === 'Retry-After' ? '2' : null) },
    };

    const result = normalizeError(err);

    expect(result.retryAfterMs).toBe(2_000);
  });

  it('falls back to type "unknown" when the error carries no http status', () => {
    const result = normalizeError(new Error('mystery failure'));

    expect(result.type).toBe('unknown');
    expect(result.status).toBeUndefined();
  });
});
