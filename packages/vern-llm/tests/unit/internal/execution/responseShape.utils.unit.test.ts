import { describe, expect, it, vi } from 'vitest';

import {
  parseAndValidate,
  shapeResponse,
  validateToolCallArguments,
  type ShapeResponseParams,
} from '../../../../src/internal/execution/utils/responseShape.utils.js';

import type { CallParams, WireToolCall } from '../../../../src/types/index.js';

function fakeLogger() {
  return { debug: vi.fn() };
}

const identityRedact = (text: string) => text;
const defaultParseJson = (content: string) => JSON.parse(content) as unknown;

function baseParams(overrides: Partial<CallParams<unknown>> = {}): CallParams<unknown> {
  return { userContent: 'hi', jsonMode: false, ...overrides };
}

function baseShapeParams<T>(
  overrides: Partial<ShapeResponseParams<T>> = {},
): ShapeResponseParams<T> {
  return {
    rawContent: 'hello world',
    wireToolCalls: undefined,
    params: baseParams() as CallParams<T>,
    useJson: false,
    parseJson: defaultParseJson,
    requestId: 'req-1',
    logger: fakeLogger(),
    redactText: identityRedact,
    ...overrides,
  };
}

describe('shapeResponse, empty response', () => {
  it('throws api/empty_response when there is neither content nor tool calls', () => {
    expect(() =>
      shapeResponse(baseShapeParams({ rawContent: undefined, wireToolCalls: undefined })),
    ).toThrow(expect.objectContaining({ type: 'api', code: 'empty_response' }));
  });

  it('throws empty_response for whitespace-only content with no tool calls', () => {
    expect(() => shapeResponse(baseShapeParams({ rawContent: '   ' }))).toThrow(
      expect.objectContaining({ code: 'empty_response' }),
    );
  });

  it('does not throw empty_response when tool calls are present, even with no content', () => {
    const wireToolCalls: WireToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
    ];
    const params = baseParams({
      tools: [{ name: 'search', description: 'search the web', parameters: {} }],
    });

    expect(() =>
      shapeResponse(baseShapeParams({ rawContent: undefined, wireToolCalls, params })),
    ).not.toThrow();
  });
});

describe('shapeResponse, tool_calls without params.tools', () => {
  it('throws validation/unexpected_tool_calls when the provider returns tool_calls but no tools were sent', () => {
    const wireToolCalls: WireToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
    ];

    expect(() =>
      shapeResponse(baseShapeParams({ wireToolCalls, params: baseParams({ tools: undefined }) })),
    ).toThrow(expect.objectContaining({ type: 'validation', code: 'unexpected_tool_calls' }));
  });
});

describe("shapeResponse, toolChoice: 'none' violated", () => {
  it('throws validation/tool_choice_none_violated when tool_calls arrive despite toolChoice none', () => {
    const wireToolCalls: WireToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
    ];
    const params = baseParams({
      tools: [{ name: 'search', description: 'search the web', parameters: {} }],
      toolChoice: 'none',
    });

    expect(() => shapeResponse(baseShapeParams({ wireToolCalls, params }))).toThrow(
      expect.objectContaining({ type: 'validation', code: 'tool_choice_none_violated' }),
    );
  });
});

describe('shapeResponse, tool_calls happy path', () => {
  it('returns a tool_calls result with parsed arguments when tools were offered', () => {
    const wireToolCalls: WireToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
    ];
    const params = baseParams({
      tools: [{ name: 'search', description: 'search the web', parameters: {} }],
    });

    const result = shapeResponse(baseShapeParams({ wireToolCalls, params, rawContent: undefined }));

    expect(result).toMatchObject({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'cats' } }],
    });
  });

  it('carries trimmed content alongside tool_calls when the provider sent both', () => {
    const wireToolCalls: WireToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
    ];
    const params = baseParams({
      tools: [{ name: 'search', description: 'search the web', parameters: {} }],
    });

    const result = shapeResponse(
      baseShapeParams({ wireToolCalls, params, rawContent: '  thinking...  ' }),
    );

    expect(result).toMatchObject({ content: 'thinking...' });
  });
});

describe('shapeResponse, params.tools set with no tool_calls', () => {
  it('wraps plain text content in a content result when tools were offered but unused', () => {
    const params = baseParams({
      tools: [{ name: 'search', description: 'search the web', parameters: {} }],
    });

    const result = shapeResponse(baseShapeParams({ params, rawContent: 'plain answer' }));

    expect(result).toEqual({ type: 'content', content: 'plain answer' });
  });

  it('wraps JSON content in a content result when useJson and tools were both set', () => {
    const params = baseParams({
      tools: [{ name: 'search', description: 'search the web', parameters: {} }],
    });

    const result = shapeResponse(
      baseShapeParams({ params, rawContent: '{"answer":42}', useJson: true }),
    );

    expect(result).toEqual({ type: 'content', content: { answer: 42 } });
  });
});

describe('shapeResponse, non-JSON passthrough', () => {
  it('returns the trimmed text content directly when useJson is false and no tools were set', () => {
    const result = shapeResponse(baseShapeParams({ rawContent: '  plain text  ', useJson: false }));
    expect(result).toBe('plain text');
  });
});

describe('shapeResponse, JSON parse failure', () => {
  it('throws a parse error when useJson is true and the content is not valid JSON', () => {
    expect(() => shapeResponse(baseShapeParams({ rawContent: 'not json', useJson: true }))).toThrow(
      expect.objectContaining({ type: 'parse' }),
    );
  });
});

describe('shapeResponse, schema validation failure', () => {
  it('throws a validation error when the parsed JSON fails the schema', () => {
    const schema = { safeParse: () => ({ success: false as const, error: 'bad shape' }) };
    const params = baseParams({ schema });

    expect(() =>
      shapeResponse(baseShapeParams({ rawContent: '{"x":1}', useJson: true, params })),
    ).toThrow(expect.objectContaining({ type: 'validation' }));
  });
});

describe('shapeResponse, debug logging', () => {
  it('logs the redacted output once content is confirmed non-empty', () => {
    const logger = fakeLogger();
    const redactText = vi.fn((text: string) => `redacted:${text}`);

    shapeResponse(
      baseShapeParams({ rawContent: 'secret', logger, redactText, requestId: 'req-x' }),
    );

    expect(redactText).toHaveBeenCalledWith('secret');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('req-x'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('redacted:secret'));
  });

  it('does not log when the response is empty (throws before reaching the log line)', () => {
    const logger = fakeLogger();

    expect(() =>
      shapeResponse(baseShapeParams({ rawContent: undefined, wireToolCalls: undefined, logger })),
    ).toThrow();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe('parseAndValidate', () => {
  it('parses and returns valid JSON when no schema is given', () => {
    expect(parseAndValidate('{"a":1}', undefined, defaultParseJson)).toEqual({ a: 1 });
  });

  it('throws a parse error for invalid JSON', () => {
    expect(() => parseAndValidate('not json', undefined, defaultParseJson)).toThrow(
      expect.objectContaining({ type: 'parse' }),
    );
  });

  it('throws a parse error when the parsed value is null', () => {
    expect(() => parseAndValidate('null', undefined, defaultParseJson)).toThrow(
      expect.objectContaining({ type: 'parse' }),
    );
  });

  it('runs the schema and returns its data on success', () => {
    const schema = { safeParse: (data: unknown) => ({ success: true as const, data }) };
    expect(parseAndValidate('{"a":1}', schema, defaultParseJson)).toEqual({ a: 1 });
  });

  it('throws a validation error when the schema rejects the parsed value', () => {
    const schema = { safeParse: () => ({ success: false as const, error: 'nope' }) };
    expect(() => parseAndValidate('{"a":1}', schema, defaultParseJson)).toThrow(
      expect.objectContaining({ type: 'validation' }),
    );
  });
});

describe('validateToolCallArguments', () => {
  const tools = [{ name: 'search', description: 'search the web', parameters: {} }];

  it('does nothing when every call names a known tool with a unique id', () => {
    expect(() =>
      validateToolCallArguments([{ id: 'call_1', name: 'search', arguments: {} }], tools),
    ).not.toThrow();
  });

  it('throws unknown_tool when a call names a tool that was not offered', () => {
    expect(() =>
      validateToolCallArguments([{ id: 'call_1', name: 'ghost', arguments: {} }], tools),
    ).toThrow(expect.objectContaining({ type: 'validation', code: 'unknown_tool' }));
  });

  it('throws duplicate_tool_call_id when two calls reuse the same id', () => {
    expect(() =>
      validateToolCallArguments(
        [
          { id: 'call_1', name: 'search', arguments: {} },
          { id: 'call_1', name: 'search', arguments: {} },
        ],
        tools,
      ),
    ).toThrow(expect.objectContaining({ type: 'validation', code: 'duplicate_tool_call_id' }));
  });

  it('runs a tool argumentsSchema when the tool declares one, and throws on a schema failure', () => {
    const toolsWithSchema = [
      {
        name: 'search',
        description: 'search the web',
        parameters: {},
        argumentsSchema: { safeParse: () => ({ success: false as const, error: 'bad args' }) },
      },
    ];

    expect(() =>
      validateToolCallArguments([{ id: 'call_1', name: 'search', arguments: {} }], toolsWithSchema),
    ).toThrow(expect.objectContaining({ type: 'validation' }));
  });

  it('does not throw when a tool with no argumentsSchema is called', () => {
    expect(() =>
      validateToolCallArguments(
        [{ id: 'call_1', name: 'search', arguments: { any: 'thing' } }],
        tools,
      ),
    ).not.toThrow();
  });
});
