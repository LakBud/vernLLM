import { describe, it, expect } from 'vitest';

import { LLMError } from '../../src/types/errors.js';

describe('LLMError.toJSON', () => {
  it('does not throw when `cause` is circular, since cause is never included', () => {
    const circular: Record<string, unknown> = { message: 'circular boom' };
    circular.self = circular;

    const err = new LLMError('boom', 'unknown', { cause: circular });

    expect(() => JSON.stringify(err)).not.toThrow();
  });

  it('includes the structured fields, and omits cause entirely', () => {
    const err = new LLMError('boom', 'api', {
      status: 500,
      code: 'server_error',
      cause: { anything: 'here' },
    });

    const parsed = JSON.parse(JSON.stringify(err));

    expect(parsed).toMatchObject({
      name: 'LLMError',
      message: 'boom',
      type: 'api',
      status: 500,
      code: 'server_error',
      retryable: true,
    });
    expect(parsed).not.toHaveProperty('cause');
  });

  it('leaves err.cause itself untouched on direct access, even when circular', () => {
    const circular: Record<string, unknown> = { message: 'x' };
    circular.self = circular;

    const err = new LLMError('boom', 'unknown', { cause: circular });
    JSON.stringify(err); // exercising toJSON should have no side effect on the instance

    expect(err.cause).toBe(circular);
  });

  it('includes message and retryable, which a plain property walk (no toJSON) would miss', () => {
    const err = new LLMError('boom', 'invalid_params');

    const parsed = JSON.parse(JSON.stringify(err));

    expect(parsed.message).toBe('boom');
    expect(parsed.retryable).toBe(false);
  });

  it('recorded attempts (already cause-free snapshots) serialize cleanly as part of the same call', () => {
    const circular: Record<string, unknown> = { message: 'down' };
    circular.self = circular;

    const err = new LLMError('down', 'network', {
      cause: circular,
      attempts: [
        { index: 0, error: new LLMError('down', 'network', { cause: circular }).toSnapshot() },
      ],
    });

    expect(() => JSON.stringify(err)).not.toThrow();
  });
});

describe('LLMError.toSnapshot', () => {
  it('never includes cause, even when cause is JSON-safe', () => {
    const err = new LLMError('boom', 'network', { cause: { code: 'ECONNRESET' } });

    const snapshot = err.toSnapshot();

    expect(snapshot).not.toHaveProperty('cause');
  });

  it('does not throw when cause is circular, since cause is never copied into the snapshot', () => {
    const circular: Record<string, unknown> = { message: 'down' };
    circular.self = circular;

    const err = new LLMError('down', 'network', { cause: circular });

    expect(() => err.toSnapshot()).not.toThrow();
    expect(() => JSON.stringify(err.toSnapshot())).not.toThrow();
  });

  it('carries the structured fields a caller actually needs to diagnose a past attempt', () => {
    const err = new LLMError('boom', 'api', { status: 500, code: 'server_error' });

    expect(err.toSnapshot()).toMatchObject({
      message: 'boom',
      type: 'api',
      status: 500,
      code: 'server_error',
      retryable: true,
    });
  });

  it('leaves LLMError.cause itself untouched: only toSnapshot/toJSON omit it, not the live field', () => {
    const cause = { anything: 'goes' };
    const err = new LLMError('boom', 'unknown', { cause });

    expect(err.cause).toBe(cause);
  });
});
