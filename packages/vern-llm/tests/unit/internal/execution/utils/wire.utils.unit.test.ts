import { describe, it, expect } from 'vitest';

import {
  toWireTools,
  toWireToolCalls,
  parseWireToolCalls,
} from '../../../../../src/internal/execution/utils/wire.utils.js';
import { LLMError } from '../../../../../src/types/errors.js';

import type { WireToolCall } from '../../../../../src/types/client.js';
import type { ToolCall, ToolDefinition } from '../../../../../src/types/tools.js';

describe('toWireTools', () => {
  it('translates a ToolDefinition into the OpenAI-shaped function wrapper', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Gets the weather',
        parameters: { type: 'object', properties: {} },
      },
    ];

    expect(toWireTools(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Gets the weather',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });

  it('maps each tool independently, preserving order', () => {
    const tools: ToolDefinition[] = [
      { name: 'a', description: 'A', parameters: {} },
      { name: 'b', description: 'B', parameters: {} },
    ];

    const result = toWireTools(tools);

    expect(result.map((t) => t.function.name)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty tools list', () => {
    expect(toWireTools([])).toEqual([]);
  });
});

describe('toWireToolCalls', () => {
  it('JSON-stringifies arguments and tags the wire shape as type "function"', () => {
    const calls: ToolCall[] = [{ id: 'call_1', name: 'get_weather', arguments: { city: 'sf' } }];

    expect(toWireToolCalls(calls)).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'sf' }) },
      },
    ]);
  });

  it('defaults missing arguments to an empty object literal', () => {
    const calls: ToolCall[] = [
      { id: 'call_1', name: 'ping', arguments: undefined as unknown as Record<string, unknown> },
    ];

    const result = toWireToolCalls(calls);

    expect(result[0]?.function.arguments).toBe('{}');
  });

  it('maps multiple tool calls independently, preserving order', () => {
    const calls: ToolCall[] = [
      { id: 'call_1', name: 'a', arguments: { x: 1 } },
      { id: 'call_2', name: 'b', arguments: { y: 2 } },
    ];

    const result = toWireToolCalls(calls);

    expect(result.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect(result.map((c) => c.function.name)).toEqual(['a', 'b']);
  });
});

describe('parseWireToolCalls', () => {
  function wireCall(id: string, name: string, args: string): WireToolCall {
    return { id, type: 'function', function: { name, arguments: args } };
  }

  it('parses valid JSON arguments back into an object', () => {
    const result = parseWireToolCalls([wireCall('call_1', 'get_weather', '{"city":"sf"}')]);

    expect(result).toEqual([{ id: 'call_1', name: 'get_weather', arguments: { city: 'sf' } }]);
  });

  it('treats an empty arguments string as an empty object, without attempting to JSON.parse it', () => {
    const result = parseWireToolCalls([wireCall('call_1', 'ping', '')]);

    expect(result).toEqual([{ id: 'call_1', name: 'ping', arguments: {} }]);
  });

  it('treats a whitespace-only arguments string the same as empty', () => {
    const result = parseWireToolCalls([wireCall('call_1', 'ping', '   ')]);

    expect(result).toEqual([{ id: 'call_1', name: 'ping', arguments: {} }]);
  });

  it('throws a coded parse LLMError on malformed JSON arguments', () => {
    expect(() =>
      parseWireToolCalls([wireCall('call_1', 'get_weather', '{not valid json')]),
    ).toThrow(LLMError);

    try {
      parseWireToolCalls([wireCall('call_1', 'get_weather', '{not valid json')]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      if (!(error instanceof LLMError)) throw error;
      expect(error.type).toBe('parse');
      expect(error.code).toBe('tool_arguments_parse_failed');
      expect(error.message).toContain('get_weather');
    }
  });

  it('parses non-object JSON args (e.g. a bare array) through unchanged, no type restriction enforced', () => {
    const result = parseWireToolCalls([wireCall('call_1', 'ping', '[1,2,3]')]);

    expect(result).toEqual([{ id: 'call_1', name: 'ping', arguments: [1, 2, 3] }]);
  });

  it('maps multiple tool calls independently, preserving order and ids', () => {
    const result = parseWireToolCalls([
      wireCall('call_1', 'a', '{"x":1}'),
      wireCall('call_2', 'b', '{"y":2}'),
    ]);

    expect(result).toEqual([
      { id: 'call_1', name: 'a', arguments: { x: 1 } },
      { id: 'call_2', name: 'b', arguments: { y: 2 } },
    ]);
  });

  it('throws on the first malformed entry even when later entries are well-formed', () => {
    expect(() =>
      parseWireToolCalls([wireCall('call_1', 'bad', '{oops'), wireCall('call_2', 'good', '{}')]),
    ).toThrow(LLMError);
  });
});
