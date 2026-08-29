import { describe, it, expect } from 'vitest';

import {
  buildReplayChunks,
  buildReplayChunksFromPromise,
} from '../../../../../src/internal/cache/utils/replay.utils.js';

import type { StreamChunk } from '../../../../../src/types/stream.js';
import type { CallWithToolsResult } from '../../../../../src/types/tools.js';

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

describe('buildReplayChunks, hasTools: false', () => {
  it('replays a string value as a single text-delta chunk unchanged', async () => {
    const chunks = await collect(buildReplayChunks('hello world', false));

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'hello world' }]);
  });

  it('JSON-stringifies a non-string (jsonMode: true) value into the text-delta chunk', async () => {
    const chunks = await collect(buildReplayChunks({ a: 1 }, false));

    expect(chunks).toEqual([{ type: 'text-delta', delta: JSON.stringify({ a: 1 }) }]);
  });

  it('never emits a usage chunk, since a cache hit spent no real tokens', async () => {
    const chunks = await collect(buildReplayChunks('hi', false));

    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
  });
});

describe('buildReplayChunks, hasTools: true, result.type "content"', () => {
  it('replays the content as a single text-delta chunk, same as the non-tools string path', async () => {
    const value: CallWithToolsResult<string> = { type: 'content', content: 'plain answer' };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'plain answer' }]);
  });

  it('JSON-stringifies non-string content under a jsonMode: true content result', async () => {
    const value = { type: 'content', content: { a: 1 } } as unknown as CallWithToolsResult<{
      a: number;
    }>;

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks).toEqual([{ type: 'text-delta', delta: JSON.stringify({ a: 1 }) }]);
  });
});

describe('buildReplayChunks, hasTools: true, result.type "tool_calls"', () => {
  it('emits one complete tool_call_delta chunk per tool call, whole args in one shot', async () => {
    const value: CallWithToolsResult<string> = {
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_1', name: 'get_weather', arguments: { city: 'sf' } },
        { id: 'call_2', name: 'get_time', arguments: { tz: 'utc' } },
      ],
    };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argsDelta: JSON.stringify({ city: 'sf' }),
        complete: true,
      },
      {
        type: 'tool_call_delta',
        index: 1,
        id: 'call_2',
        name: 'get_time',
        argsDelta: JSON.stringify({ tz: 'utc' }),
        complete: true,
      },
    ]);
  });

  it('defaults a tool call with no arguments to an empty-object argsDelta', async () => {
    const value: CallWithToolsResult<string> = {
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_1', name: 'ping', arguments: undefined as unknown as Record<string, unknown> },
      ],
    };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'ping',
        argsDelta: '{}',
        complete: true,
      },
    ]);
  });

  it('appends a trailing text-delta chunk when the tool_calls result also carries content', async () => {
    const value: CallWithToolsResult<string> = {
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'sf' } }],
      content: 'Let me check that for you.',
    };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argsDelta: JSON.stringify({ city: 'sf' }),
        complete: true,
      },
      { type: 'text-delta', delta: 'Let me check that for you.' },
    ]);
  });

  it('omits the trailing text-delta chunk when the tool_calls result has no content', async () => {
    const value: CallWithToolsResult<string> = {
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }],
    };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([]);
  });

  it('omits the trailing text-delta chunk when content is an empty string (falsy)', async () => {
    const value: CallWithToolsResult<string> = {
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }],
      content: '',
    };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([]);
  });

  it('emits no tool_call_delta chunks for an empty toolCalls array', async () => {
    const value: CallWithToolsResult<string> = { type: 'tool_calls', toolCalls: [] };

    const chunks = await collect(buildReplayChunks(value, true));

    expect(chunks).toEqual([]);
  });

  it('the returned iterable is single-use only in the sense of re-iterating the same fixed items (not a live stream), but can be iterated more than once since items are precomputed', async () => {
    const value: CallWithToolsResult<string> = { type: 'content', content: 'again' };
    const chunks = buildReplayChunks(value, true);

    expect(await collect(chunks)).toEqual([{ type: 'text-delta', delta: 'again' }]);
    expect(await collect(chunks)).toEqual([{ type: 'text-delta', delta: 'again' }]);
  });
});

describe('buildReplayChunksFromPromise', () => {
  it('awaits the promise, then delegates to buildReplayChunks with the resolved value', async () => {
    const value: CallWithToolsResult<string> = { type: 'content', content: 'resolved text' };

    const chunks = await collect(buildReplayChunksFromPromise(Promise.resolve(value), true));

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'resolved text' }]);
  });

  it('resolves a non-tools promised value the same way as the sync hasTools: false path', async () => {
    const chunks = await collect(buildReplayChunksFromPromise(Promise.resolve('plain'), false));

    expect(chunks).toEqual([{ type: 'text-delta', delta: 'plain' }]);
  });

  it('propagates a promise rejection when the chunks iterable is iterated, mirroring a live stream mid-failure', async () => {
    const failure = new Error('upstream call failed');
    const chunks = buildReplayChunksFromPromise(Promise.reject(failure), false);

    await expect(collect(chunks)).rejects.toThrow('upstream call failed');
  });

  it('does not touch the promise until the iterable is actually iterated', async () => {
    let settled = false;
    const promise = Promise.resolve('value').then((v) => {
      settled = true;
      return v;
    });

    const chunks = buildReplayChunksFromPromise(promise, false);
    // Constructing the iterable shouldn't itself await the promise.
    expect(settled).toBe(false);

    await collect(chunks);
    expect(settled).toBe(true);
  });
});
