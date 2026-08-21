import { describe, it, expect } from 'vitest';

import { LLMError, toRequestSnapshot } from '../../src/types/errors.js';

describe('toRequestSnapshot', () => {
  it('returns provider, model, body, and startedAt', () => {
    const before = Date.now();
    const snapshot = toRequestSnapshot('openai', 'gpt-4o', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    const after = Date.now();

    expect(snapshot.provider).toBe('openai');
    expect(snapshot.model).toBe('gpt-4o');
    expect(snapshot.body).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
    expect(snapshot.startedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.startedAt).toBeLessThanOrEqual(after);
  });

  it('strips auth headers, case insensitively, and leaves other headers untouched', () => {
    const snapshot = toRequestSnapshot(
      'openai',
      'gpt-4o',
      { messages: [] },
      {
        Authorization: 'Bearer secret',
        'x-api-key': 'secret',
        'X-Api-Key': 'secret',
        'x-goog-api-key': 'secret',
        'api-key': 'secret',
        'content-type': 'application/json',
      },
    );

    expect(snapshot.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('leaves headers undefined when none were given', () => {
    const snapshot = toRequestSnapshot('openai', 'gpt-4o', { messages: [] });

    expect(snapshot.headers).toBeUndefined();
  });

  it('replaces a circular body with a marker string instead of throwing', () => {
    const circular: Record<string, unknown> = { messages: [] };
    circular.self = circular;

    const snapshot = toRequestSnapshot('openai', 'gpt-4o', circular);

    expect(snapshot.body).toBe('[Unserializable: request body contained a circular reference]');
  });
});

describe('LLMError request snapshots on attempts', () => {
  it('safeAttempts strips auth headers on a hand built nested attempt request', () => {
    // Bypasses toRequestSnapshot entirely, the same way the existing
    // hand built circular-issues test bypasses toSnapshot(): attempts is a
    // public constructor option, so a caller can construct a RetryAttempt
    // directly with unstripped headers.
    const err = new LLMError('boom', 'api', {
      attempts: [
        {
          index: 0,
          error: new LLMError('down', 'network').toSnapshot(),
          request: {
            provider: 'openai',
            model: 'gpt-4o',
            body: { ok: true },
            headers: { Authorization: 'Bearer secret', 'content-type': 'application/json' },
            startedAt: Date.now(),
          },
        },
      ],
    });

    const parsed = JSON.parse(JSON.stringify(err));
    expect(parsed.attempts[0].request.headers).toEqual({ 'content-type': 'application/json' });
    expect(err.toSnapshot().attempts?.[0]?.request?.headers).toEqual({
      'content-type': 'application/json',
    });
  });

  it('safeAttempts maps request.body through safeBody, recursively', () => {
    const circularBody: Record<string, unknown> = { messages: [] };
    circularBody.self = circularBody;

    const err = new LLMError('boom', 'api', {
      attempts: [
        {
          index: 0,
          error: new LLMError('down', 'network').toSnapshot(),
          request: toRequestSnapshot('openai', 'gpt-4o', { ok: true }),
        },
      ],
    });

    // Mutate the already-captured request body into a circular reference,
    // same scenario as the existing circular-issues-after-snapshot test.
    const attempt = err.attempts?.[0];
    if (attempt?.request) {
      (attempt.request as { body: unknown }).body = circularBody;
    }

    expect(() => JSON.stringify(err)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(err));
    expect(parsed.attempts[0].request.body).toBe(
      '[Unserializable: request body contained a circular reference]',
    );
  });

  it('toSnapshot and toJSON both carry request through nested attempts', () => {
    const err = new LLMError('boom', 'api', {
      attempts: [
        {
          index: 0,
          error: new LLMError('down', 'network').toSnapshot(),
          request: toRequestSnapshot('anthropic', 'claude-3', { messages: ['hi'] }),
        },
      ],
    });

    expect(err.toSnapshot().attempts?.[0]?.request?.provider).toBe('anthropic');
    expect(
      (err.toJSON().attempts as Array<{ request?: { provider?: string } }>)[0]?.request?.provider,
    ).toBe('anthropic');
  });

  it('request is absent on attempts predating this field', () => {
    const err = new LLMError('boom', 'api', {
      attempts: [{ index: 0, error: new LLMError('down', 'network').toSnapshot() }],
    });

    expect(err.toSnapshot().attempts?.[0]?.request).toBeUndefined();
  });
});
