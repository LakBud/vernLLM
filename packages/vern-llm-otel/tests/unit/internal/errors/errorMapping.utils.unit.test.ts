import { createRequire } from 'node:module';
import { FallbackExhaustedError, LLMError, type FallbackAttempt } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  errorAttributes,
  errorTypeOf,
  exceptionOf,
  fallbackAttemptCountOf,
  httpStatusOf,
  isLLMErrorLike,
  lastAttemptErrorOf,
  statusMessageOf,
} from '../../../../src/internal/errors/errorMapping.utils.js';

// A class that only looks like an LLMError, as a second copy of vern-llm would produce.
class LLMErrorFromAnotherCopy extends Error {
  override name = 'LLMError';
  constructor(
    public type: string,
    public code?: string,
    public status?: number,
  ) {
    super('foreign');
  }
}

describe('error mapping', () => {
  const snapshotAttempt = (provider: string): FallbackAttempt => ({
    index: 0,
    provider,
    model: 'm',
    error: new LLMError('x', 'api', { status: 500 }).toSnapshot(),
  });

  it('prefers code over type for a VernLLM error', () => {
    const error = new LLMError('provider said no', 'api', { code: 'server_error', status: 500 });
    expect(errorTypeOf(error)).toBe('server_error');
  });

  it('uses type when there is no code', () => {
    expect(errorTypeOf(new LLMError('x', 'timeout'))).toBe('timeout');
  });

  it('reports fallback_exhausted for a fallback exhausted error', () => {
    const error = new FallbackExhaustedError([
      snapshotAttempt('primary'),
      snapshotAttempt('fallback[0]'),
    ]);
    expect(errorTypeOf(error)).toBe('fallback_exhausted');
    expect(fallbackAttemptCountOf(error)).toBe(2);
  });

  it.each([
    ['a plain Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
    ['a string', 'boom'],
    ['a number', 500],
    ['null', null],
    ['undefined', undefined],
    ['an object with no name', { type: 'api' }],
    ['an object named LLMError with no type', { name: 'LLMError' }],
    ['an object named LLMError with a numeric type', { name: 'LLMError', type: 5 }],
    ['an array', []],
  ])('maps %s to _OTHER', (_label, value) => {
    expect(errorTypeOf(value)).toBe('_OTHER');
    expect(isLLMErrorLike(value)).toBe(false);
  });

  it('recognises a foreign class named LLMError, which instanceof would miss', () => {
    const foreign = new LLMErrorFromAnotherCopy('api', 'server_error', 503);

    expect(foreign instanceof LLMError).toBe(false);
    expect(isLLMErrorLike(foreign)).toBe(true);
    expect(errorTypeOf(foreign)).toBe('server_error');
    expect(httpStatusOf(foreign)).toBe(503);
  });

  describe('errors built by the other module format of vern-llm', () => {
    // A real second class, not a stand in: the CJS build of vern-llm has its own LLMError, so an
    // error it throws is not an instance of the one imported through ESM here.
    const cjs = createRequire(import.meta.url)('vern-llm') as typeof import('vern-llm');

    it('really is a different class, which is why the shape check exists', () => {
      const error = new cjs.LLMError('boom', 'api', { code: 'server_error', status: 500 });

      expect(cjs.LLMError).not.toBe(LLMError);
      expect(error instanceof LLMError).toBe(false);
      expect(isLLMErrorLike(error)).toBe(true);
    });

    it('classifies its errors exactly like the ones from this copy', () => {
      const other = new cjs.LLMError('boom', 'api', { code: 'server_error', status: 500 });
      const own = new LLMError('boom', 'api', { code: 'server_error', status: 500 });

      expect(errorAttributes(other)).toEqual(errorAttributes(own));
      expect(errorAttributes(other)).toEqual({
        'error.type': 'server_error',
        'http.response.status_code': 500,
      });
      expect(exceptionOf(other, false)).toEqual(exceptionOf(own, false));
    });

    it('reads an exhausted fallback chain built by the other copy', () => {
      const snapshot = new cjs.LLMError('down', 'api', {
        code: 'server_error',
        status: 502,
      }).toSnapshot();
      const error = new cjs.FallbackExhaustedError([
        { index: 0, provider: 'primary', model: 'm', error: snapshot },
      ]);

      expect(errorTypeOf(error)).toBe('fallback_exhausted');
      expect(fallbackAttemptCountOf(error)).toBe(1);
      expect(httpStatusOf(lastAttemptErrorOf(error))).toBe(502);
    });
  });

  it('ignores a non string or empty code and falls back to type', () => {
    expect(errorTypeOf({ name: 'LLMError', type: 'network', code: 42 })).toBe('network');
    expect(errorTypeOf({ name: 'LLMError', type: 'network', code: '' })).toBe('network');
  });

  it('falls back to _OTHER when both code and type are empty', () => {
    expect(errorTypeOf({ name: 'LLMError', type: '', code: '' })).toBe('_OTHER');
  });

  it('uses the same low cardinality string as the status message, never the message', () => {
    const error = new LLMError('the prompt was: my secret', 'api', { code: 'authentication' });

    expect(statusMessageOf(error)).toBe('authentication');
    expect(statusMessageOf(error)).not.toContain('secret');
    expect(statusMessageOf(new Error('secret'))).toBe('_OTHER');
  });

  describe('httpStatusOf', () => {
    it.each([100, 200, 404, 429, 500, 599])('accepts %s', (status) => {
      expect(httpStatusOf(new LLMError('x', 'api', { status }))).toBe(status);
    });

    it.each([99, 600, 0, -1, 500.5, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
      'rejects %s',
      (status) => {
        expect(httpStatusOf(new LLMError('x', 'api', { status }))).toBeUndefined();
      },
    );

    it('rejects a string status and any non LLM error', () => {
      expect(httpStatusOf({ name: 'LLMError', type: 'api', status: '500' })).toBeUndefined();
      expect(httpStatusOf(new Error('x'))).toBeUndefined();
      expect(httpStatusOf(null)).toBeUndefined();
    });
  });

  describe('fallbackAttemptCountOf', () => {
    it('is undefined for an ordinary error', () => {
      expect(fallbackAttemptCountOf(new LLMError('x', 'api'))).toBeUndefined();
    });

    it('is undefined when attempts is not a list', () => {
      expect(
        fallbackAttemptCountOf({ name: 'LLMError', type: 'fallback_exhausted', attempts: 'many' }),
      ).toBeUndefined();
    });

    it('counts an empty list as zero', () => {
      expect(
        fallbackAttemptCountOf({ name: 'LLMError', type: 'fallback_exhausted', attempts: [] }),
      ).toBe(0);
    });

    it('is undefined for a non error', () => {
      expect(fallbackAttemptCountOf('x')).toBeUndefined();
    });
  });

  describe('lastAttemptErrorOf', () => {
    it('returns the last target failure of an exhausted fallback chain', () => {
      const error = new FallbackExhaustedError([
        {
          index: 0,
          provider: 'primary',
          model: 'm',
          error: new LLMError('x', 'api', { code: 'server_error', status: 500 }).toSnapshot(),
        },
        {
          index: 1,
          provider: 'fallback[0]',
          model: 'm',
          error: new LLMError('y', 'timeout', { code: 'request_timeout' }).toSnapshot(),
        },
      ]);

      const last = lastAttemptErrorOf(error);

      expect(errorTypeOf(last)).toBe('request_timeout');
      expect(httpStatusOf(last)).toBeUndefined();
    });

    it('keeps the last status when it has one', () => {
      const error = new FallbackExhaustedError([snapshotAttempt('primary')]);
      expect(httpStatusOf(lastAttemptErrorOf(error))).toBe(500);
    });

    it.each([
      ['an ordinary VernLLM error', new LLMError('x', 'api')],
      ['a plain Error', new Error('x')],
      ['null', null],
      ['a string', 'boom'],
    ])('returns %s unchanged', (_label, value) => {
      expect(lastAttemptErrorOf(value)).toBe(value);
    });

    it.each([
      ['no attempts', []],
      ['a null entry', [null]],
      ['an entry with no error', [{}]],
      ['an entry with a null error', [{ error: null }]],
      ['an error with no type', [{ error: { code: 'x' } }]],
    ])('falls back to the summary error for %s', (_label, attempts) => {
      const error = { name: 'LLMError', type: 'fallback_exhausted', attempts };
      expect(lastAttemptErrorOf(error)).toBe(error);
    });
  });

  describe('exceptionOf', () => {
    it('records the low cardinality code, never the message, for a VernLLM error', () => {
      const error = new LLMError('the prompt said: secret', 'api', { code: 'server_error' });

      expect(exceptionOf(error, false)).toEqual({ name: 'LLMError', message: 'server_error' });
    });

    it('uses the type when there is no code', () => {
      expect(exceptionOf(new LLMError('x', 'timeout'), false)).toEqual({
        name: 'LLMError',
        message: 'timeout',
      });
    });

    it('recognises a foreign class named LLMError by shape', () => {
      expect(exceptionOf(new LLMErrorFromAnotherCopy('api', 'server_error'), false)).toEqual({
        name: 'LLMError',
        message: 'server_error',
      });
    });

    it.each([
      ['a plain Error', new Error('secret text')],
      ['a string', 'secret text'],
      ['null', null],
      ['undefined', undefined],
    ])('calls %s a generic Error with the _OTHER code', (_label, value) => {
      const record = exceptionOf(value, false);

      expect(record).toEqual({ name: 'Error', message: '_OTHER' });
      expect(JSON.stringify(record)).not.toContain('secret');
    });

    it('adds the stack only when asked, and only when there is one', () => {
      const error = new LLMError('x', 'api');

      expect(exceptionOf(error, false)).not.toHaveProperty('stack');
      expect(exceptionOf(error, true).stack).toBe(error.stack);
      expect(exceptionOf('no stack here', true)).not.toHaveProperty('stack');
      expect(exceptionOf({ name: 'LLMError', type: 'api', stack: 42 }, true)).not.toHaveProperty(
        'stack',
      );
    });
  });

  describe('errorAttributes', () => {
    it('combines the type, http status, and fallback count', () => {
      const error = new FallbackExhaustedError([snapshotAttempt('primary')]);

      expect(errorAttributes(error)).toEqual({
        'error.type': 'fallback_exhausted',
        'http.response.status_code': 500,
        'vernllm.fallback.attempts': 1,
      });
    });

    it('is just error.type when nothing else applies', () => {
      expect(errorAttributes(new Error('x'))).toEqual({ 'error.type': '_OTHER' });
      expect(errorAttributes(undefined)).toEqual({ 'error.type': '_OTHER' });
    });

    it('never carries an undefined value', () => {
      expect(Object.values(errorAttributes(new LLMError('x', 'timeout')))).not.toContain(undefined);
    });
  });
});
