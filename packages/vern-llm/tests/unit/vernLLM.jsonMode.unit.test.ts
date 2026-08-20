import { describe, it, expect, expectTypeOf, onTestFinished, vi } from 'vitest';

import { VernLLM, type ConversationTurn, type JsonValue } from '../../src/index.js';
import {
  at,
  createMockClient,
  createMockStreamingClient,
  jsonResponse,
  textResponse,
} from '../helpers.js';

describe('VernLLM.call, jsonMode return type and runtime shape', () => {
  it('jsonMode: false returns the raw string, unparsed', async () => {
    const { client } = createMockClient([textResponse('hello there')]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('hello there');
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it('jsonMode: true returns the parsed JSON value, not a string', async () => {
    const { client } = createMockClient([jsonResponse({ a: 1, b: [true, null] })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({ userContent: 'hi', jsonMode: true });

    expect(result).toEqual({ a: 1, b: [true, null] });
    expectTypeOf(result).toEqualTypeOf<JsonValue>();
  });

  it('jsonMode: true parses a top-level array', async () => {
    const { client } = createMockClient([jsonResponse([1, 2, 3])]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({ userContent: 'hi', jsonMode: true });

    expect(result).toEqual([1, 2, 3]);
  });

  it('jsonMode: true parses a top-level primitive', async () => {
    const { client } = createMockClient([jsonResponse(42)]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({ userContent: 'hi', jsonMode: true });

    expect(result).toBe(42);
  });

  it('a schema call still infers T from the schema, not JsonValue', async () => {
    const { client } = createMockClient([jsonResponse({ name: 'Ada' })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call<{ name: string }>({
      userContent: 'hi',
      jsonMode: true,
      schema: { safeParse: (d) => ({ success: true, data: d as { name: string } }) },
    });

    expectTypeOf(result).toEqualTypeOf<{ name: string }>();
  });

  it('a schema call without an explicit type argument still infers T from the schema, not JsonValue', async () => {
    // No explicit `<T>`, forcing overload resolution to pick between
    // `JsonModeEnabledCallParams` and the generic `CallParams<T>` fallback
    // purely on the object literal's own shape. `JsonModeEnabledCallParams`
    // types `schema` as `never`, so any call that sets `schema` at all
    // fails this overload's structural check and falls through to the
    // generic overload, regardless of the schema's own result type.
    interface Candidate {
      name: string;
      skills: string[];
    }

    const { client } = createMockClient([jsonResponse({ name: 'Ada', skills: ['ts'] })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      userContent: 'hi',
      jsonMode: true,
      schema: {
        safeParse: (d) => ({ success: true, data: d as Candidate }),
      } satisfies { safeParse(d: unknown): { success: true; data: Candidate } },
    });

    expectTypeOf(result).toEqualTypeOf<Candidate>();
    expect(result.name).toBe('Ada');
  });

  it('a schema whose result type is itself JsonValue-compatible (e.g. a string array) still infers the precise type, not JsonValue', async () => {
    // Regression test: before `JsonModeEnabledCallParams` typed `schema` as
    // `never`, a schema whose inferred result type happened to be
    // structurally assignable to `JsonValue` (arrays and index-signature
    // objects both qualify, since `JsonValue` includes `JsonValue[]` and
    // `{ [key: string]: JsonValue }`) would incorrectly select the
    // `JsonValue`-returning overload instead of the schema-aware one.
    const { client } = createMockClient([jsonResponse(['ts', 'js'])]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      userContent: 'hi',
      jsonMode: true,
      schema: {
        safeParse: (d) => ({ success: true, data: d as string[] }),
      } satisfies { safeParse(d: unknown): { success: true; data: string[] } },
    });

    expectTypeOf(result).toEqualTypeOf<string[]>();
    expect(result).toEqual(['ts', 'js']);
  });
});

describe('VernLLM.cachedCall, jsonMode return type and runtime shape', () => {
  it('jsonMode: false returns the raw string, unparsed', async () => {
    const { client } = createMockClient([textResponse('hello there')]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.cachedCall({
      cacheKey: 'k1',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false },
    });

    expect(result).toBe('hello there');
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it('jsonMode: true returns the parsed JSON value, not a string', async () => {
    const { client } = createMockClient([jsonResponse({ a: 1, b: [true, null] })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.cachedCall({
      cacheKey: 'k2',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: true },
    });

    expect(result).toEqual({ a: 1, b: [true, null] });
    expectTypeOf(result).toEqualTypeOf<JsonValue>();
  });

  it('a cache hit replays the same JsonValue shape without re-parsing a string', async () => {
    const { client, create } = createMockClient([jsonResponse({ name: 'Ada' })]);
    const llm = new VernLLM({ client, model: 'm' });

    const first = await llm.cachedCall({
      cacheKey: 'k3',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: true },
    });

    // The parse spy is installed only after the miss above, so its call
    // count isolates exactly what the cache-hit path itself does: `runCached`
    // returns `cached.value` directly on a hit (see `CacheOrchestrator.runCached`),
    // never re-invoking `call()` or its JSON parsing, only the object stored
    // from the original miss is replayed.
    const parseSpy = vi.spyOn(JSON, 'parse');
    onTestFinished(() => parseSpy.mockRestore());

    const second = await llm.cachedCall({
      cacheKey: 'k3',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: true },
    });

    expect(first).toEqual({ name: 'Ada' });
    expect(second).toEqual({ name: 'Ada' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('a schema call through cachedCall still infers T from the schema, not JsonValue', async () => {
    const { client } = createMockClient([jsonResponse({ name: 'Ada' })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.cachedCall<{ name: string }>({
      cacheKey: 'k4',
      ttl: 60,
      call: {
        userContent: 'hi',
        jsonMode: true,
        schema: { safeParse: (d) => ({ success: true, data: d as { name: string } }) },
      },
    });

    expectTypeOf(result).toEqualTypeOf<{ name: string }>();
  });

  it('a JsonValue-compatible schema (string array) through cachedCall without an explicit generic still infers the precise type', async () => {
    const { client } = createMockClient([jsonResponse(['ts', 'js'])]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.cachedCall({
      cacheKey: 'k4b',
      ttl: 60,
      call: {
        userContent: 'hi',
        jsonMode: true,
        schema: {
          safeParse: (d) => ({ success: true, data: d as string[] }),
        } satisfies { safeParse(d: unknown): { success: true; data: string[] } },
      },
    });

    expectTypeOf(result).toEqualTypeOf<string[]>();
    expect(result).toEqual(['ts', 'js']);
  });
});

describe('VernLLM.call, streaming + jsonMode return type', () => {
  it('stream: true with jsonMode: false resolves finalResult to a string', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hello' }]]);
    const llm = new VernLLM({ client, model: 'm' });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    const result = await finalResult;

    expect(result).toBe('hello');
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it('stream: true with jsonMode: true resolves finalResult to a JsonValue', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: '{"a":1}' }]]);
    const llm = new VernLLM({ client, model: 'm' });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: true, stream: true });
    const result = await finalResult;

    expect(result).toEqual({ a: 1 });
    expectTypeOf(result).toEqualTypeOf<JsonValue>();
  });

  it('stream: true with a JsonValue-compatible schema still infers the precise type, not JsonValue', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: '["ts","js"]' }]]);
    const llm = new VernLLM({ client, model: 'm' });

    const { finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: true,
      stream: true,
      schema: {
        safeParse: (d) => ({ success: true, data: d as string[] }),
      } satisfies { safeParse(d: unknown): { success: true; data: string[] } },
    });
    const result = await finalResult;

    expectTypeOf(result).toEqualTypeOf<string[]>();
    expect(result).toEqual(['ts', 'js']);
  });
});

describe('VernLLM.cachedCall, streaming + jsonMode return type', () => {
  it('stream: true with jsonMode: false resolves finalResult to a string', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hello' }]]);
    const llm = new VernLLM({ client, model: 'm' });

    const { finalResult } = await llm.cachedCall({
      cacheKey: 'k5',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });
    const result = await finalResult;

    expect(result).toBe('hello');
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it('stream: true with jsonMode: true resolves finalResult to a JsonValue', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: '{"a":1}' }]]);
    const llm = new VernLLM({ client, model: 'm' });

    const { finalResult } = await llm.cachedCall({
      cacheKey: 'k6',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: true, stream: true },
    });
    const result = await finalResult;

    expect(result).toEqual({ a: 1 });
    expectTypeOf(result).toEqualTypeOf<JsonValue>();
  });
});

describe('VernLLM.call, JSON-safe assistant history', () => {
  it('accepts a parsed JsonValue directly in a ConversationTurn without a cast', () => {
    const parsed: JsonValue = { name: 'Ada', skills: ['ts'] };

    const history: ConversationTurn[] = [
      { role: 'user', content: 'give me json' },
      { role: 'assistant', content: parsed },
    ];

    expect(history[1]).toEqual({ role: 'assistant', content: parsed });
  });

  it('round-trips a jsonMode: true response through history as JSON text on the wire', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ name: 'Ada', skills: ['ts'] }),
      textResponse('ok'),
    ]);
    const llm = new VernLLM({ client, model: 'm' });

    const parsed = await llm.call({ userContent: 'extract', jsonMode: true });

    const history: ConversationTurn[] = [
      { role: 'user', content: 'extract' },
      { role: 'assistant', content: parsed },
    ];

    await llm.call({ userContent: 'thanks', jsonMode: false, history });

    expect(at(calls, 1).messages[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify({ name: 'Ada', skills: ['ts'] }),
    });
  });
});
