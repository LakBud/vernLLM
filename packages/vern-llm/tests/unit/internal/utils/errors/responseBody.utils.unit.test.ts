import { describe, expect, it, vi } from 'vitest';

import {
  errorWithResponseBody,
  redactResponseBody,
} from '../../../../../src/internal/utils/errors/responseBody.utils.js';

describe('errorWithResponseBody', () => {
  it('embeds the body after the prefix, truncated to 500 chars', () => {
    const error = errorWithResponseBody('Request failed (500)', 'x'.repeat(600));

    expect(error.message).toBe(`Request failed (500): ${'x'.repeat(500)}`);
  });
});

describe('redactResponseBody', () => {
  it('rewrites the body through redact and keeps the prefix', () => {
    const error = errorWithResponseBody('Request failed (400)', 'key sk-secret rejected');

    redactResponseBody(error, (text) => text.replace(/sk-\w+/g, '[REDACTED]'));

    expect(error.message).toBe('Request failed (400): key [REDACTED] rejected');
    expect(error.stack?.split('\n')[0]).toBe(
      'Error: Request failed (400): key [REDACTED] rejected',
    );
    expect(error.stack).not.toContain('sk-secret');
  });

  it('runs at most once per error', () => {
    const error = errorWithResponseBody('Request failed (400)', 'body');
    const redact = vi.fn((text: string) => `<${text}>`);

    redactResponseBody(error, redact);
    redactResponseBody(error, redact);

    expect(redact).toHaveBeenCalledOnce();
    expect(error.message).toBe('Request failed (400): <body>');
  });

  it('withholds the body instead of leaking it when redact throws', () => {
    const error = errorWithResponseBody('Request failed (400)', 'sk-secret');

    redactResponseBody(error, () => {
      throw new Error('redact bug');
    });

    expect(error.message).toBe('Request failed (400): [response body withheld: redact threw]');
  });

  it('leaves errors it did not build untouched', () => {
    const error = new Error('Request failed (400): sk-secret');
    const redact = vi.fn(() => 'redacted');

    redactResponseBody(error, redact);
    redactResponseBody('not an error', redact);

    expect(redact).not.toHaveBeenCalled();
    expect(error.message).toBe('Request failed (400): sk-secret');
  });

  it('rewrites a stack that is only the message line', () => {
    const error = errorWithResponseBody('Request failed (400)', 'sk-secret');
    error.stack = `Error: ${error.message}`;

    redactResponseBody(error, () => '[REDACTED]');

    expect(error.stack).toBe('Error: Request failed (400): [REDACTED]');
  });

  it('leaves a missing stack alone', () => {
    const error = errorWithResponseBody('Request failed (400)', 'sk-secret');
    error.stack = undefined;

    redactResponseBody(error, () => '[REDACTED]');

    expect(error.message).toBe('Request failed (400): [REDACTED]');
    expect(error.stack).toBeUndefined();
  });

  it('removes every line of a multi-line body from the stack and keeps the frames', () => {
    const error = errorWithResponseBody(
      'Request failed (400)',
      'line one sk-a\nline two sk-b\nline three',
    );

    // Something read the stack first (a logger, a debugger), so V8 has
    // already formatted it with the raw body in it.
    expect(error.stack).toContain('line two sk-b');

    redactResponseBody(error, (text) => text.replace(/sk-\w+/g, '[REDACTED]'));

    expect(error.stack).not.toContain('sk-a');
    expect(error.stack).not.toContain('sk-b');
    expect(error.stack?.startsWith(`Error: ${error.message}`)).toBe(true);
    expect(error.stack).toMatch(/\n\s+at /);
  });

  it('removes every line of a multi-line body from the stack when redact throws', () => {
    const error = errorWithResponseBody('Request failed (400)', 'first sk-a\nsecond sk-b');
    expect(error.stack).toContain('second sk-b');

    redactResponseBody(error, () => {
      throw new Error('redact bug');
    });

    expect(error.stack).not.toContain('sk-a');
    expect(error.stack).not.toContain('second');
    expect(error.stack?.split('\n')[0]).toBe(
      'Error: Request failed (400): [response body withheld: redact threw]',
    );
    expect(error.stack).toMatch(/\n\s+at /);
  });

  it('drops a stack that was rewritten elsewhere rather than risk keeping body text', () => {
    const error = errorWithResponseBody('Request failed (400)', 'sk-secret\nmore');
    error.stack = 'CustomPrefix sk-secret\nmore\n    at somewhere';

    redactResponseBody(error, () => '[REDACTED]');

    expect(error.stack).toBe('Error: Request failed (400): [REDACTED]');
  });
});
