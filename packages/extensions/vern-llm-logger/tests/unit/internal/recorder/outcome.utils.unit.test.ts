import { LLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  classifyOutcome,
  errorCodeOf,
  isLocalRejection,
  isQualityFailure,
  lastAttemptErrorOf,
} from '../../../../src/internal/recorder/outcome.utils.js';

const failed = (error: unknown) => classifyOutcome({ kind: 'error', error });

describe('classifyOutcome', () => {
  it('classifies a result as ok at info', () => {
    expect(classifyOutcome({ kind: 'result', result: { value: 'x' } })).toEqual({
      outcome: 'ok',
      level: 'info',
    });
  });

  it('classifies a provider failure as an error, keeping only type, code and status', () => {
    const error = new LLMError('secret prompt text', 'api', { status: 500, code: 'server_error' });

    expect(failed(error)).toEqual({
      outcome: 'error',
      level: 'error',
      error: { type: 'api', code: 'server_error', status: 500 },
    });
  });

  it('never carries the message', () => {
    const result = failed(new LLMError('secret prompt text', 'api', { status: 500 }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('classifies a cancelled call as aborted at info, since nothing is wrong', () => {
    expect(failed(new LLMError('stop', 'aborted'))).toEqual({
      outcome: 'aborted',
      level: 'info',
      error: { type: 'aborted' },
    });
  });

  it.each([
    ['a budget', new LLMError('over', 'quota_exceeded', { code: 'budget_exceeded' as never })],
    ['a plain quota', new LLMError('over', 'quota_exceeded')],
    ['a policy denial', new LLMError('no', 'invalid_params', { code: 'policy_denied' as never })],
    ['a content refusal', new LLMError('no', 'invalid_params', { code: 'content_blocked' })],
  ])('classifies %s as rejected at warn, not as a fault', (_name, error) => {
    const result = failed(error);

    expect(result.outcome).toBe('rejected');
    expect(result.level).toBe('warn');
  });

  it('does not treat other invalid params as a rejection', () => {
    expect(failed(new LLMError('bad', 'invalid_params')).outcome).toBe('error');
  });

  it('recognises an error by shape, so a second copy of vern-llm still works', () => {
    const foreign = { name: 'LLMError', type: 'timeout', code: 'attempt_timeout' };

    expect(failed(foreign)).toEqual({
      outcome: 'error',
      level: 'error',
      error: { type: 'timeout', code: 'attempt_timeout' },
    });
  });

  it.each([[new Error('boom')], ['text'], [undefined], [null], [{ type: 'api' }], [42]])(
    'reports %j as an unknown error',
    (error) => {
      expect(failed(error)).toEqual({
        outcome: 'error',
        level: 'error',
        error: { type: 'unknown' },
      });
    },
  );

  it.each([[99], [600], [200.5], [Number.NaN], ['500']])(
    'drops the invalid status %j',
    (status) => {
      const error = { name: 'LLMError', type: 'api', status };
      expect(failed(error).error).toEqual({ type: 'api' });
    },
  );

  it('drops an empty code', () => {
    expect(failed({ name: 'LLMError', type: 'api', code: '' }).error).toEqual({ type: 'api' });
  });
});

describe('errorCodeOf', () => {
  it('prefers the code, then the type', () => {
    expect(errorCodeOf(new LLMError('x', 'api', { code: 'server_error' }))).toBe('server_error');
    expect(errorCodeOf(new LLMError('x', 'aborted'))).toBe('aborted');
  });

  it('reports anything else as unknown', () => {
    expect(errorCodeOf(new Error('x'))).toBe('unknown');
    expect(errorCodeOf(undefined)).toBe('unknown');
  });
});

describe('lastAttemptErrorOf', () => {
  const exhausted = (attempts: unknown) =>
    ({ name: 'LLMError', type: 'fallback_exhausted', attempts }) as unknown;

  it("returns the last attempt's own reason for an exhausted chain", () => {
    const error = exhausted([
      { error: { type: 'timeout', code: 'attempt_timeout' } },
      { error: { type: 'api', code: 'server_error' } },
    ]);

    expect(lastAttemptErrorOf(error)).toEqual({
      name: 'LLMError',
      type: 'api',
      code: 'server_error',
    });
  });

  it.each([
    ['no attempts', exhausted([])],
    ['attempts that are not a list', exhausted('x')],
    ['an attempt with no error', exhausted([{ error: undefined }])],
    ['an attempt error with no type', exhausted([{ error: { code: 'x' } }])],
    ['a null attempt', exhausted([null])],
  ])('returns the error unchanged for %s', (_name, error) => {
    expect(lastAttemptErrorOf(error)).toBe(error);
  });

  it('returns any other error unchanged', () => {
    const error = new LLMError('x', 'api');
    expect(lastAttemptErrorOf(error)).toBe(error);
    expect(lastAttemptErrorOf('text')).toBe('text');
  });
});

describe('isLocalRejection', () => {
  const rejection = (code: string, status?: number) =>
    new LLMError('x', 'invalid_params', { code: code as never, status });

  it('is true for a capability or middleware rejection that sent nothing', () => {
    expect(isLocalRejection(rejection('unsupported_capability'))).toBe(true);
    expect(isLocalRejection(rejection('middleware_threw'))).toBe(true);
  });

  it('is false once the provider answered with a status', () => {
    expect(isLocalRejection(rejection('unsupported_capability', 400))).toBe(false);
  });

  it('is false for other codes, other types, and non errors', () => {
    expect(isLocalRejection(rejection('other'))).toBe(false);
    expect(
      isLocalRejection(new LLMError('x', 'api', { code: 'unsupported_capability' as never })),
    ).toBe(false);
    expect(isLocalRejection(new Error('x'))).toBe(false);
  });
});

describe('isQualityFailure', () => {
  it.each([
    ['validation', new LLMError('x', 'validation')],
    ['parse', new LLMError('x', 'parse')],
    ['truncated', new LLMError('x', 'parse', { code: 'response_truncated' as never })],
    ['tool contract', new LLMError('x', 'validation', { code: 'unknown_tool' as never })],
    ['soft failure', new LLMError('x', 'api', { code: 'soft_failure_detected' as never })],
    ['empty response', new LLMError('x', 'api', { code: 'empty_response' as never })],
  ])('counts %s', (_name, error) => {
    expect(isQualityFailure(error)).toBe(true);
  });

  it.each([
    ['a timeout', new LLMError('x', 'timeout')],
    ['a network error', new LLMError('x', 'network')],
    ['a 429', new LLMError('x', 'rate_limited', { status: 429 })],
    ['a 5xx', new LLMError('x', 'api', { status: 500, code: 'server_error' as never })],
    ['caller input', new LLMError('x', 'invalid_params')],
    ['a budget rejection', new LLMError('x', 'quota_exceeded')],
    ['an abort', new LLMError('x', 'aborted')],
    ['an open circuit', new LLMError('x', 'circuit_open')],
    ['a plain error', new Error('x')],
    ['nothing', undefined],
  ])('does not count %s', (_name, error) => {
    expect(isQualityFailure(error)).toBe(false);
  });
});
