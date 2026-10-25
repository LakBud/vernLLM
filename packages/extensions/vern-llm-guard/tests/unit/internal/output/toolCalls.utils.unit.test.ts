import { describe, expect, it } from 'vitest';

import {
  mergeDelta,
  toolChunk,
  type OpenCall,
} from '../../../../src/internal/output/toolCalls.utils.js';

import type { StreamChunk } from 'vern-llm';

type Delta = Extract<StreamChunk, { type: 'tool_call_delta' }>;
const delta = (extra: Partial<Delta>): Delta => ({ type: 'tool_call_delta', index: 0, ...extra });

describe('mergeDelta', () => {
  it('starts a call and adds to its arguments', () => {
    const calls = new Map<number, OpenCall>();
    mergeDelta(calls, delta({ id: 'c1', name: 'search', argsDelta: '{"q":' }));
    mergeDelta(calls, delta({ argsDelta: '"x"}' }));

    expect(calls.get(0)).toEqual({ id: 'c1', name: 'search', args: '{"q":"x"}' });
  });

  it('replaces the arguments when a delta says it is complete', () => {
    const calls = new Map<number, OpenCall>();
    mergeDelta(calls, delta({ argsDelta: 'partial' }));
    mergeDelta(calls, delta({ argsDelta: '{"whole":true}', complete: true }));

    expect(calls.get(0)!.args).toBe('{"whole":true}');
  });

  it('keeps calls apart by index and tolerates a delta with no arguments', () => {
    const calls = new Map<number, OpenCall>();
    mergeDelta(calls, delta({ index: 0, id: 'a' }));
    mergeDelta(calls, delta({ index: 1, id: 'b', argsDelta: '{}' }));

    expect([...calls.keys()]).toEqual([0, 1]);
    expect(calls.get(0)).toEqual({ id: 'a', args: '' });
  });
});

describe('toolChunk', () => {
  it('is one complete delta with the checked arguments', () => {
    expect(toolChunk(2, { id: 'c', name: 'n', args: 'raw' }, '{"ok":1}')).toEqual({
      type: 'tool_call_delta',
      index: 2,
      id: 'c',
      name: 'n',
      argsDelta: '{"ok":1}',
      complete: true,
    });
  });

  it('leaves out an id or a name the call never had', () => {
    expect(toolChunk(0, { args: '' }, '{}')).toEqual({
      type: 'tool_call_delta',
      index: 0,
      argsDelta: '{}',
      complete: true,
    });
  });
});
