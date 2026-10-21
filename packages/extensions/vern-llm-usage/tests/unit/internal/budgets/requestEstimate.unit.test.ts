import { describe, expect, it } from 'vitest';

import {
  estimateAnswerTokens,
  estimateRequestTokens,
} from '../../../../src/internal/budgets/requestEstimate.js';

import type { WireCallRequest } from 'vern-llm';

const request = (extra: Partial<WireCallRequest> = {}): WireCallRequest => ({
  model: 'm',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'abcdefgh' }],
  ...extra,
});

describe('estimateRequestTokens', () => {
  it('counts max_tokens once, as output', () => {
    expect(estimateRequestTokens(request())).toEqual({ total: 102, input: 2, output: 100 });
  });

  it('adds tool definitions and the response schema to the input', () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'f', description: 'd', parameters: { type: 'object' } },
      },
    ];
    const withTools = estimateRequestTokens(request({ tools }));
    const withSchema = estimateRequestTokens(
      request({
        response_format: {
          type: 'json_schema',
          json_schema: { name: 's', schema: { type: 'object' } },
        },
      }),
    );

    expect(withTools.input).toBeGreaterThan(2);
    expect(withTools.output).toBe(100);
    expect(withSchema.input).toBeGreaterThan(2);
    expect(withSchema.total).toBe(withSchema.input + 100);
  });

  it('counts nothing for a schema that has no JSON form, and never throws', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // A circular value throws in JSON.stringify, a function has no JSON at all.
    for (const odd of [circular, () => 1]) {
      expect(estimateRequestTokens(request({ tools: odd as never }))).toEqual({
        total: 102,
        input: 2,
        output: 100,
      });
    }
  });
});

describe('estimateAnswerTokens', () => {
  it('counts a string as it is, four characters a token, rounded up', () => {
    expect(estimateAnswerTokens('abcd')).toBe(1);
    expect(estimateAnswerTokens('abcde')).toBe(2);
    expect(estimateAnswerTokens('')).toBe(0);
  });

  it('counts anything else as its JSON', () => {
    // '{"a":1}' is 7 characters.
    expect(estimateAnswerTokens({ a: 1 })).toBe(2);
  });

  it('counts nothing for a value with no JSON form', () => {
    expect(estimateAnswerTokens(undefined)).toBe(0);
    expect(estimateAnswerTokens(() => 1)).toBe(0);
  });
});
