import { describe, expect, it } from 'vitest';

import { createToolCallAccumulator } from '../../../../../../src/internal/execution/utils/stream/toolCallAccumulator.utils.js';

describe('createToolCallAccumulator, apply', () => {
  it('returns a tool_call_delta StreamChunk matching the given delta', () => {
    const accumulator = createToolCallAccumulator();

    const chunk = accumulator.apply({
      index: 0,
      id: 'call_1',
      name: 'search',
      argumentsDelta: '{"q":',
    });

    expect(chunk).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'search',
      argsDelta: '{"q":',
      complete: undefined,
    });
  });

  it('merges later deltas at the same index into the same entry', () => {
    const accumulator = createToolCallAccumulator();

    accumulator.apply({ index: 0, id: 'call_1', name: 'search', argumentsDelta: '{"q":' });
    accumulator.apply({ index: 0, argumentsDelta: '"cats"}' });

    expect(accumulator.toWireToolCalls()).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
    ]);
  });

  it('keeps the first id/name seen at an index, ignoring later undefined deltas', () => {
    const accumulator = createToolCallAccumulator();

    accumulator.apply({ index: 0, id: 'call_1', name: 'search', argumentsDelta: '' });
    accumulator.apply({ index: 0, argumentsDelta: 'more' });

    expect(accumulator.toWireToolCalls()).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: 'more' } },
    ]);
  });

  it('throws LLMError validation once more than 10000 distinct indices are seen', () => {
    const accumulator = createToolCallAccumulator();

    for (let i = 0; i < 10_000; i++) accumulator.apply({ index: i });

    expect(() => accumulator.apply({ index: 10_000 })).toThrow(
      'Stream contained more than 10000 distinct tool calls',
    );
  });

  it('does not count repeated deltas at an already-seen index toward the call limit', () => {
    const accumulator = createToolCallAccumulator();

    for (let i = 0; i < 10_000; i++) accumulator.apply({ index: i });

    expect(() => accumulator.apply({ index: 0, argumentsDelta: 'more' })).not.toThrow();
  });

  it('throws LLMError validation once accumulated arguments exceed the length limit', () => {
    const accumulator = createToolCallAccumulator();
    const chunk = 'x'.repeat(1_000_000);

    accumulator.apply({ index: 0, argumentsDelta: chunk });

    expect(() => accumulator.apply({ index: 0, argumentsDelta: 'x' })).toThrow(
      'Tool call arguments exceeded the 1000000-character stream limit',
    );
  });
});

describe('createToolCallAccumulator, toWireToolCalls', () => {
  it('returns undefined when nothing was ever applied', () => {
    const accumulator = createToolCallAccumulator();

    expect(accumulator.toWireToolCalls()).toBeUndefined();
  });

  it('sorts entries by index regardless of the order deltas arrived in', () => {
    const accumulator = createToolCallAccumulator();

    accumulator.apply({ index: 2, id: 'c', name: 'third' });
    accumulator.apply({ index: 0, id: 'a', name: 'first' });
    accumulator.apply({ index: 1, id: 'b', name: 'second' });

    expect(accumulator.toWireToolCalls()?.map((call) => call.function.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('defaults a missing id or name to an empty string rather than undefined', () => {
    const accumulator = createToolCallAccumulator();

    accumulator.apply({ index: 0, argumentsDelta: '{}' });

    expect(accumulator.toWireToolCalls()).toEqual([
      { id: '', type: 'function', function: { name: '', arguments: '{}' } },
    ]);
  });
});
