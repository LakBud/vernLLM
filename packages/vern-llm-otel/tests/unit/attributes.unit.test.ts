import { createRequire } from 'node:module';
import { FallbackExhaustedError, LLMError, type CallMeta, type FallbackAttempt } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  attemptStartAttributes,
  type AttemptStartInput,
  callEndAttributes,
  callStartAttributes,
  elapsedMs,
  errorAttributes,
  errorTypeOf,
  exceptionOf,
  fallbackAttemptCountOf,
  httpStatusOf,
  isLlmErrorLike,
  lastAttemptErrorOf,
  noAttemptReasonOf,
  nowMs,
  outputTypeOf,
  sanitizeAttributes,
  statusMessageOf,
  usageAttributes,
  usageFailureAttributes,
} from '../../src/attributes.js';

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

const bad = (value: unknown) => value as never;

function attemptInput(overrides: Partial<AttemptStartInput> = {}): AttemptStartInput {
  return {
    provider: 'openai',
    target: 'primary',
    model: 'gpt-4o',
    attempt: 1,
    isFallback: false,
    request: { max_tokens: 512, temperature: 0.2 },
    ...overrides,
  };
}

describe('attemptStartAttributes', () => {
  it('sets the sampling relevant and request attributes', () => {
    expect(attemptStartAttributes(attemptInput(), true)).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.request.max_tokens': 512,
      'gen_ai.request.temperature': 0.2,
      'gen_ai.output.type': 'text',
      'vernllm.target': 'primary',
      'vernllm.attempt': 1,
      'vernllm.is_fallback': false,
    });
  });

  it('keeps a zero temperature and a zero max_tokens, since both are valid values', () => {
    const attrs = attemptStartAttributes(
      attemptInput({ request: { max_tokens: 0, temperature: 0 } }),
      true,
    );

    expect(attrs['gen_ai.request.temperature']).toBe(0);
    expect(attrs['gen_ai.request.max_tokens']).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, bad('0.5'), bad(null)])(
    'drops a non finite or non numeric temperature (%s)',
    (temperature) => {
      const attrs = attemptStartAttributes(
        attemptInput({ request: { max_tokens: 1, temperature } }),
        true,
      );

      expect(attrs).not.toHaveProperty('gen_ai.request.temperature');
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, bad('10'), bad(undefined)])(
    'drops an invalid max_tokens (%s)',
    (max_tokens) => {
      const attrs = attemptStartAttributes(attemptInput({ request: { max_tokens } }), true);
      expect(attrs).not.toHaveProperty('gen_ai.request.max_tokens');
    },
  );

  it('marks a json request', () => {
    const attrs = attemptStartAttributes(
      attemptInput({ request: { max_tokens: 1, response_format: { type: 'json_object' } } }),
      true,
    );

    expect(attrs['gen_ai.output.type']).toBe('json');
  });

  it('also sends the reasoning level under the GenAI name, only with GenAI conventions on', () => {
    const input = attemptInput({ request: { max_tokens: 1, reasoning_effort: 'high' } });

    expect(attemptStartAttributes(input, true)).toMatchObject({
      'gen_ai.request.reasoning.level': 'high',
      'vernllm.request.reasoning_effort': 'high',
    });

    const off = attemptStartAttributes(input, false);
    expect(off).not.toHaveProperty('gen_ai.request.reasoning.level');
    expect(off['vernllm.request.reasoning_effort']).toBe('high');
  });

  it.each(['', undefined, bad(5), bad(null)])(
    'leaves out an unusable reasoning level (%s)',
    (effort) => {
      const attrs = attemptStartAttributes(
        attemptInput({ request: { max_tokens: 1, reasoning_effort: effort as never } }),
        true,
      );

      expect(attrs).not.toHaveProperty('gen_ai.request.reasoning.level');
    },
  );

  it('records reasoning effort and budget tokens as VernLLM attributes', () => {
    const attrs = attemptStartAttributes(
      attemptInput({ request: { max_tokens: 1, reasoning_effort: 'high', budget_tokens: 2048 } }),
      true,
    );

    expect(attrs['vernllm.request.reasoning_effort']).toBe('high');
    expect(attrs['vernllm.request.budget_tokens']).toBe(2048);
  });

  it.each([Number.NaN, -5, Number.POSITIVE_INFINITY])('drops an invalid budget (%s)', (budget) => {
    const attrs = attemptStartAttributes(
      attemptInput({ request: { max_tokens: 1, budget_tokens: budget } }),
      true,
    );

    expect(attrs).not.toHaveProperty('vernllm.request.budget_tokens');
  });

  it.each([0, -1, 1.5, Number.NaN, bad('2')])('drops an invalid attempt number (%s)', (attempt) => {
    expect(attemptStartAttributes(attemptInput({ attempt }), true)).not.toHaveProperty(
      'vernllm.attempt',
    );
  });

  it('marks a fallback attempt, and treats a non boolean as false', () => {
    expect(attemptStartAttributes(attemptInput({ isFallback: true }), true)).toMatchObject({
      'vernllm.is_fallback': true,
    });
    expect(attemptStartAttributes(attemptInput({ isFallback: bad('yes') }), true)).toMatchObject({
      'vernllm.is_fallback': false,
    });
  });

  it('emits only vernllm attributes when GenAI conventions are off', () => {
    const attrs = attemptStartAttributes(attemptInput(), false);

    expect(Object.keys(attrs).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
    expect(attrs).toMatchObject({ 'vernllm.target': 'primary', 'vernllm.attempt': 1 });
  });

  it('never carries an undefined value', () => {
    const attrs = attemptStartAttributes(attemptInput({ request: { max_tokens: 1 } }), true);
    expect(Object.values(attrs)).not.toContain(undefined);
  });
});

describe('outputTypeOf', () => {
  it('is json only when a response format is present', () => {
    expect(outputTypeOf({})).toBe('text');
    expect(outputTypeOf({ response_format: { type: 'json_object' } })).toBe('json');
  });
});

describe('usageAttributes', () => {
  it('maps prompt, completion, and reasoning tokens', () => {
    expect(
      usageAttributes({ promptTokens: 10, completionTokens: 20, reasoningTokens: 5 }, true),
    ).toEqual({
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.reasoning.output_tokens': 5,
    });
  });

  it('keeps zero, which is a real count', () => {
    expect(
      usageAttributes({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, true),
    ).toEqual({
      'gen_ai.usage.input_tokens': 0,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.reasoning.output_tokens': 0,
    });
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    bad('5'),
    bad(null),
  ])('skips a value that is not a finite non negative number (%s)', (value) => {
    expect(
      usageAttributes(
        { promptTokens: value, completionTokens: value, reasoningTokens: value },
        true,
      ),
    ).toEqual({});
  });

  it('sets reasoning tokens only when defined', () => {
    const attrs = usageAttributes({ promptTokens: 1, completionTokens: 2 }, true);
    expect(attrs).not.toHaveProperty('gen_ai.usage.reasoning.output_tokens');
  });

  it('handles an empty object', () => {
    expect(usageAttributes({}, true)).toEqual({});
  });

  it('emits nothing when GenAI conventions are off', () => {
    expect(usageAttributes({ promptTokens: 1, completionTokens: 2 }, false)).toEqual({});
  });
});

describe('usageFailureAttributes', () => {
  it('adds the failure marker to the token attributes', () => {
    expect(usageFailureAttributes({ promptTokens: 4, completionTokens: 0 }, true)).toEqual({
      'gen_ai.usage.input_tokens': 4,
      'gen_ai.usage.output_tokens': 0,
      'vernllm.usage.failed': true,
    });
  });

  it('still marks the failure with GenAI conventions off', () => {
    expect(usageFailureAttributes({ promptTokens: 4 }, false)).toEqual({
      'vernllm.usage.failed': true,
    });
  });
});

describe('callStartAttributes', () => {
  it('sets the request id and primary target', () => {
    expect(
      callStartAttributes({
        requestId: 'req_1',
        primaryProvider: 'primary',
        primaryModel: 'gpt-4o',
      }),
    ).toEqual({
      'vernllm.request_id': 'req_1',
      'vernllm.primary.provider': 'primary',
      'vernllm.primary.model': 'gpt-4o',
    });
  });

  it.each(['', bad(undefined), bad(null), bad(5)])(
    'drops an empty or non string value (%s)',
    (value) => {
      expect(
        callStartAttributes({ requestId: value, primaryProvider: value, primaryModel: value }),
      ).toEqual({});
    },
  );
});

describe('noAttemptReasonOf', () => {
  const table: [string, Parameters<typeof noAttemptReasonOf>[0], string | undefined][] = [
    [
      'attempted, meta present',
      { attemptCount: 1, hasMeta: true, shortCircuitedBy: undefined },
      undefined,
    ],
    [
      'attempted, no meta',
      { attemptCount: 3, hasMeta: false, shortCircuitedBy: undefined },
      undefined,
    ],
    [
      'attempted and short circuited',
      { attemptCount: 1, hasMeta: true, shortCircuitedBy: 'x' },
      undefined,
    ],
    [
      'no attempt, no meta',
      { attemptCount: 0, hasMeta: false, shortCircuitedBy: undefined },
      'cache_hit',
    ],
    [
      'no attempt, meta present',
      { attemptCount: 0, hasMeta: true, shortCircuitedBy: undefined },
      'coalesced',
    ],
    [
      'no attempt, short circuit, no meta',
      { attemptCount: 0, hasMeta: false, shortCircuitedBy: 'guard' },
      'short_circuit',
    ],
    [
      'no attempt, short circuit, meta',
      { attemptCount: 0, hasMeta: true, shortCircuitedBy: 'guard' },
      'short_circuit',
    ],
    [
      'empty short circuit name is not one',
      { attemptCount: 0, hasMeta: false, shortCircuitedBy: '' },
      'cache_hit',
    ],
  ];

  it.each(table)('%s', (_label, input, expected) => {
    expect(noAttemptReasonOf(input)).toBe(expected);
  });
});

describe('callEndAttributes', () => {
  const meta: CallMeta = {
    provider: 'fallback[0]',
    model: 'claude',
    fallbackIndex: 1,
    usedFallback: true,
    attempts: 3,
  };

  it('describes an answered call', () => {
    expect(
      callEndAttributes({
        meta,
        totalAttempts: 3,
        streaming: false,
        noAttemptReason: undefined,
        shortCircuitedBy: undefined,
      }),
    ).toEqual({
      'vernllm.answered.provider': 'fallback[0]',
      'vernllm.answered.model': 'claude',
      'vernllm.used_fallback': true,
      'vernllm.fallback_index': 1,
      'vernllm.total_attempts': 3,
      'vernllm.streaming': false,
    });
  });

  it('describes a call with no meta and no attempt', () => {
    expect(
      callEndAttributes({
        meta: undefined,
        totalAttempts: 0,
        streaming: false,
        noAttemptReason: 'cache_hit',
        shortCircuitedBy: undefined,
      }),
    ).toEqual({
      'vernllm.total_attempts': 0,
      'vernllm.streaming': false,
      'vernllm.no_attempt.reason': 'cache_hit',
    });
  });

  it('records the short circuiting middleware', () => {
    const attrs = callEndAttributes({
      meta: undefined,
      totalAttempts: 0,
      streaming: true,
      noAttemptReason: 'short_circuit',
      shortCircuitedBy: 'guard',
    });

    expect(attrs).toMatchObject({
      'vernllm.short_circuit.by': 'guard',
      'vernllm.streaming': true,
      'vernllm.no_attempt.reason': 'short_circuit',
    });
  });

  it('skips malformed meta fields instead of writing them', () => {
    const attrs = callEndAttributes({
      meta: bad({
        provider: '',
        model: 7,
        fallbackIndex: -1,
        usedFallback: 'yes',
        attempts: Number.NaN,
      }),
      totalAttempts: Number.NaN,
      streaming: bad('true'),
      noAttemptReason: undefined,
      shortCircuitedBy: undefined,
    });

    expect(attrs).toEqual({ 'vernllm.used_fallback': false, 'vernllm.streaming': false });
  });

  it.each([-1, 1.5, Number.NaN])('skips a bad fallback index (%s)', (fallbackIndex) => {
    const attrs = callEndAttributes({
      meta: { ...meta, fallbackIndex },
      totalAttempts: 1,
      streaming: false,
      noAttemptReason: undefined,
      shortCircuitedBy: undefined,
    });

    expect(attrs).not.toHaveProperty('vernllm.fallback_index');
  });
});

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
    expect(isLlmErrorLike(value)).toBe(false);
  });

  it('recognises a foreign class named LLMError, which instanceof would miss', () => {
    const foreign = new LLMErrorFromAnotherCopy('api', 'server_error', 503);

    expect(foreign instanceof LLMError).toBe(false);
    expect(isLlmErrorLike(foreign)).toBe(true);
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
      expect(isLlmErrorLike(error)).toBe(true);
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

describe('sanitizeAttributes', () => {
  it('keeps strings, booleans, finite numbers, and homogeneous arrays', () => {
    expect(
      sanitizeAttributes({
        'app.tenant': 'acme',
        'app.flag': false,
        'app.count': 0,
        'app.tags': ['a', 'b'],
        'app.scores': [1, 2.5],
        'app.bits': [true, false],
        'app.empty': [],
      }),
    ).toEqual({
      'app.tenant': 'acme',
      'app.flag': false,
      'app.count': 0,
      'app.tags': ['a', 'b'],
      'app.scores': [1, 2.5],
      'app.bits': [true, false],
      'app.empty': [],
    });
  });

  it('drops anything OpenTelemetry cannot carry, without stringifying it', () => {
    expect(
      sanitizeAttributes({
        nested: { secret: 'x' },
        nothing: null,
        missing: undefined,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        big: 10n,
        fn: () => 1,
        sym: Symbol('s'),
        mixed: [1, 'a'],
        withNull: ['a', null],
        badNumbers: [1, Number.NaN],
        [' ']: 'kept because only an empty key is invalid',
        '': 'dropped',
      }),
    ).toEqual({ ' ': 'kept because only an empty key is invalid' });
  });

  it.each([undefined, null, 'string', 5, true, ['a'], () => ({})])(
    'returns an empty bag for a non object (%s)',
    (value) => {
      expect(sanitizeAttributes(value)).toEqual({});
    },
  );
});

describe('clock helpers', () => {
  it('nowMs is monotonic and finite', () => {
    const a = nowMs();
    const b = nowMs();

    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('subtracts the wait from the elapsed time', () => {
    expect(elapsedMs(100, 30, 200)).toBe(70);
    expect(elapsedMs(100, 0, 200)).toBe(100);
    expect(elapsedMs(100, undefined, 200)).toBe(100);
  });

  it('clamps at zero when the wait exceeds the elapsed time or the clock goes backwards', () => {
    expect(elapsedMs(100, 500, 200)).toBe(0);
    expect(elapsedMs(200, 0, 100)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50])(
    'ignores an unusable wait (%s)',
    (waited) => {
      expect(elapsedMs(100, waited, 200)).toBe(100);
    },
  );

  it.each([
    [Number.NaN, 200],
    [100, Number.NaN],
    [Number.POSITIVE_INFINITY, 200],
    [100, Number.POSITIVE_INFINITY],
  ])('returns zero for a non finite endpoint (%s, %s)', (start, end) => {
    expect(elapsedMs(start, 0, end)).toBe(0);
  });

  it('reads the clock itself when no end is given', () => {
    expect(elapsedMs(nowMs() - 5)).toBeGreaterThanOrEqual(5);
  });
});
