import { describe, expect, it } from 'vitest';

import {
  attemptStartAttributes,
  callEndAttributes,
  callStartAttributes,
  noAttemptReasonOf,
  outputTypeOf,
  usageAttributes,
  usageFailureAttributes,
  type AttemptStartInput,
} from '../../../../src/internal/attributes/spanAttributes.utils.js';

import type { CallMeta } from 'vern-llm';

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
