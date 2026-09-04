import { describe, it, expect } from 'vitest';

import {
  describeError,
  normalizeError,
} from '../../../../../src/internal/execution/utils/errors.utils.js';
import { LLMError } from '../../../../../src/types/errors.js';

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
    const original = new LLMError('rate limited', 'api', { status: 429 });

    const result = normalizeError(original);

    expect(result).toBe(original);
    expect(result.code).toBe('provider_rate_limited');
  });

  it('does not overwrite an existing code on an already-normalized 429 LLMError', () => {
    const original = new LLMError('rate limited', 'api', {
      status: 429,
      code: 'rate_limit_queue_full',
    });

    const result = normalizeError(original);

    expect(result.code).toBe('rate_limit_queue_full');
  });

  it('tags an already-normalized LLMError carrying status 401 with code "authentication"', () => {
    const original = new LLMError('unauthorized', 'api', { status: 401 });

    const result = normalizeError(original);

    expect(result).toBe(original);
    expect(result.code).toBe('authentication');
  });

  it('tags an already-normalized LLMError carrying status 403 with code "authorization"', () => {
    const original = new LLMError('forbidden', 'api', { status: 403 });

    const result = normalizeError(original);

    expect(result).toBe(original);
    expect(result.code).toBe('authorization');
  });

  it('does not overwrite an existing code on an already-normalized 401/403 LLMError', () => {
    const unauthorized = new LLMError('unauthorized', 'api', {
      status: 401,
      code: 'rate_limit_queue_full',
    });
    const forbidden = new LLMError('forbidden', 'api', {
      status: 403,
      code: 'rate_limit_queue_full',
    });

    expect(normalizeError(unauthorized).code).toBe('rate_limit_queue_full');
    expect(normalizeError(forbidden).code).toBe('rate_limit_queue_full');
  });

  it('does not add a code to an already-normalized LLMError with a status that maps to none', () => {
    const original = new LLMError('teapot', 'api', { status: 418 });

    const result = normalizeError(original);

    expect(result.code).toBeUndefined();
  });

  it('wraps an error carrying an http status as type "api" and preserves the status', () => {
    const result = normalizeError({ status: 500 });

    expect(result.type).toBe('api');
    expect(result.status).toBe(500);
    expect(result.code).toBe('server_error');
  });

  it('tags a fresh 404 as code "not_found"', () => {
    const result = normalizeError({ status: 404 });

    expect(result.type).toBe('api');
    expect(result.code).toBe('not_found');
  });

  it('tags a fresh 413 as code "payload_too_large"', () => {
    const result = normalizeError({ status: 413 });

    expect(result.type).toBe('api');
    expect(result.code).toBe('payload_too_large');
  });

  it("falls back to AWS SDK v3's $metadata.httpStatusCode when status/statusCode are absent", () => {
    const result = normalizeError({
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
    });

    expect(result.type).toBe('api');
    expect(result.status).toBe(429);
  });

  it('folds a provider error payload into .message instead of the generic fallback', () => {
    const result = normalizeError({
      status: 400,
      error: { type: 'invalid_request_error', message: 'model does not support tools' },
    });

    expect(result.type).toBe('api');
    expect(result.message).toContain('invalid_request_error');
    expect(result.message).toContain('model does not support tools');
    expect(result.message).not.toBe('LLM request failed');
  });

  it('folds a plain .message onto .message when there is no .error payload', () => {
    const result = normalizeError({ status: 404, message: 'thing not found' });

    expect(result.message).toBe('LLM request failed: thing not found');
  });

  it('gives a specific, actionable message for a status with no error detail at all (empty body)', () => {
    const result = normalizeError({ status: 400, message: '400 status code (no body)' });

    expect(result.type).toBe('api');
    expect(result.status).toBe(400);
    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).toContain('400');
    expect(result.message).not.toBe('LLM request failed');
  });

  it('gives the same "no detail" message when the error has an empty .message and no .error payload', () => {
    const result = normalizeError({ status: 500, message: '' });

    expect(result.message).toContain('no error detail from the provider');
  });

  it('gives a neutral no-detail message (no field-guidance) for a body-less 401 authentication error', () => {
    const result = normalizeError({ status: 401, message: '401 status code (no body)' });

    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).not.toContain('field or value');
    expect(result.message).not.toContain('auth problem');
  });

  it('gives a neutral no-detail message (no field-guidance) for a body-less 500 server error', () => {
    const result = normalizeError({ status: 500, message: '500 status code (no body)' });

    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).not.toContain('field or value');
  });

  it('treats a status-only object with no message/error as "no detail", not as its own local serialization', () => {
    const result = normalizeError({ status: 500 });

    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).toContain('500');
  });

  it('treats an explicit `error: null` as no detail, not as a literal "null" description', () => {
    const result = normalizeError({ status: 400, error: null });

    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).not.toContain('null');
  });

  it('treats an empty `error: {}` payload as no detail, not as literal "{}"', () => {
    const result = normalizeError({ status: 400, error: {} });

    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).not.toContain('{}');
  });

  it("treats an empty `error: ''` payload as no detail, not as literal '\"\"'", () => {
    const result = normalizeError({ status: 400, error: '' });

    expect(result.message).toContain('no error detail from the provider');
    expect(result.message).not.toContain('""');
  });

  it('does not treat a real, non-"(no body)" message as having no detail', () => {
    const result = normalizeError({ status: 400, message: 'invalid API key' });

    expect(result.message).toBe('LLM request failed: invalid API key');
    expect(result.message).not.toContain('no error detail from the provider');
  });

  it('prefers a present .error payload over the "(no body)" pattern, even if .message also matches it', () => {
    const result = normalizeError({
      status: 400,
      message: '400 status code (no body)',
      error: { type: 'invalid_request_error', message: 'bad field' },
    });

    expect(result.message).not.toContain('no error detail from the provider');
    expect(result.message).toContain('bad field');
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

  it('does not tag a status-less error as "network" unless it carries a recognized network signal', () => {
    const result = normalizeError(new Error('mystery failure'));

    expect(result.type).toBe('unknown');
    expect(result.code).toBeUndefined();
  });

  it('tags a status-less error as type "network", code "connection_failed" when it carries a known libuv error code', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });

    const result = normalizeError(err);

    expect(result.type).toBe('network');
    expect(result.code).toBe('connection_failed');
  });

  it('tags a status-less error as type "network", code "connection_failed" when the message matches fetch\'s own transport-failure wording', () => {
    const result = normalizeError(new TypeError('fetch failed'));

    expect(result.type).toBe('network');
    expect(result.code).toBe('connection_failed');
  });

  it('tags a status-less error as type "network", code "connection_failed" via a wrapped cause carrying a known libuv error code', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), {
      code: 'ENOTFOUND',
    });
    const err = new TypeError('fetch failed but phrased differently', { cause });

    const result = normalizeError(err);

    expect(result.type).toBe('network');
    expect(result.code).toBe('connection_failed');
  });

  it('does not tag an unrelated error code as "connection_failed"', () => {
    const err = Object.assign(new Error('boom'), { code: 'SOME_APP_ERROR' });

    const result = normalizeError(err);

    expect(result.type).toBe('unknown');
    expect(result.code).toBeUndefined();
  });

  it('carries a given attempts array through onto a freshly built LLMError', () => {
    const attempts = [
      { index: 0, error: new LLMError('first try failed', 'api', { status: 500 }) },
    ];

    const result = normalizeError(new Error('boom'), undefined, attempts);

    expect(result.attempts).toBe(attempts);
  });

  it('leaves attempts undefined on a freshly built LLMError when none is given', () => {
    const result = normalizeError(new Error('boom'));

    expect(result.attempts).toBeUndefined();
  });

  it('fills in attempts on an already-normalized LLMError that has none yet', () => {
    const original = new LLMError('already normalized', 'validation');
    const attempts = [
      { index: 0, error: new LLMError('first try failed', 'api', { status: 500 }) },
    ];

    const result = normalizeError(original, undefined, attempts);

    expect(result).toBe(original);
    expect(result.attempts).toBe(attempts);
  });

  it('does not overwrite attempts already set on an already-normalized LLMError', () => {
    const existing = [{ index: 0, error: new LLMError('existing', 'api', { status: 500 }) }];
    const original = new LLMError('already normalized', 'validation', { attempts: existing });
    const incoming = [{ index: 0, error: new LLMError('incoming', 'api', { status: 500 }) }];

    const result = normalizeError(original, undefined, incoming);

    expect(result.attempts).toBe(existing);
  });
});

describe('describeError', () => {
  it('prefers a truthy `error` payload over `message`, JSON-stringified', () => {
    const result = describeError({ message: 'ignored', error: { code: 'bad_request' } });

    expect(result).toBe(JSON.stringify({ code: 'bad_request' }, null, 2));
  });

  it('falls back to the Error message when no `error` payload exists', () => {
    const result = describeError(new Error('boom'));

    expect(result).toBe('boom');
  });

  it('returns a safe string instead of throwing when the `error` payload is circular', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = describeError({ error: circular });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to "[unprintable error]" when both JSON.stringify and String() throw', () => {
    // Circular so JSON.stringify throws, and a toString/Symbol.toPrimitive
    // that also throws so the String() fallback can't rescue it either.
    const unprintable: Record<string, unknown> = {
      toString() {
        throw new Error('cannot stringify');
      },
      [Symbol.toPrimitive]() {
        throw new Error('cannot coerce');
      },
    };
    unprintable.self = unprintable;

    const result = describeError({ error: unprintable });

    expect(result).toBe('[unprintable error]');
  });
});
