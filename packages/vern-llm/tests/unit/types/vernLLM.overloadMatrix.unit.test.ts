import { describe, it, expect, expectTypeOf } from 'vitest';

import {
  isStreamResult,
  isToolCallResult,
  type CallWithToolsResult,
  type ContentResult,
  type JsonValue,
  type StreamCallResult,
  type ToolDefinition,
} from '../../../src/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  jsonResponse,
  textResponse,
  toolCallResponse,
  drain,
} from '../../helpers.js';

// Pins the return type of every `call()`/`cachedCall()` overload, in the
// same order they're declared in `vernLLM.ts`. If a refactor reorders two
// signatures such that a different (but structurally compatible) overload
// wins for one of these param shapes, the corresponding `expectTypeOf`
// stops matching and `pnpm typecheck:test` fails, even though every
// runtime assertion would still pass. Each test also drives a real
// (mocked) call so the shape is verified at runtime too.

const weatherTool = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
} satisfies ToolDefinition;

const stringSchema = {
  safeParse: (d: unknown) => ({ success: true as const, data: String(d) }),
};

describe('call() overload matrix (declaration order)', () => {
  it('1. stream + tools disabled -> StreamCallResult<ContentResult<T>>', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'sunny' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<string>({
      userContent: 'hi',
      stream: true,
      tools: [weatherTool],
      toolChoice: 'none',
    });
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<StreamCallResult<ContentResult<string>>>();
    expect(finalResult).toEqual({ type: 'content', content: 'sunny' });
  });

  it('1b. regression: a plain tools array literal still resolves ContentResult, not CallWithToolsResult, with no explicit generic', async () => {
    // Previously, `toolChoice: 'none'` with an inline `tools: [...]` array
    // and no explicit `call<T>()` type argument silently fell through to
    // the tools-*enabled* overload instead (its `const Tools` type param
    // won inference over this overload's non-inferred one), defeating the
    // whole point of `toolChoice: 'none'` narrowing: `result` would type
    // as `CallWithToolsResult<...>` even though a `tool_calls` response is
    // impossible here. Fixed by giving this overload its own `const
    // Tools` parameter (see `ToolsDisabledCallParams` usage in `call()`).
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      userContent: 'hi',
      tools: [weatherTool],
      toolChoice: 'none',
    });

    expectTypeOf(result).toEqualTypeOf<ContentResult<unknown>>();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('2. stream + tools enabled -> StreamCallResult<CallWithToolsResult<T, Tools>>', async () => {
    const { client } = createMockStreamingClient([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          argumentsDelta: '{"city":"Boston"}',
          complete: true,
        },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      userContent: 'hi',
      stream: true,
      tools: [weatherTool],
    });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<
      StreamCallResult<CallWithToolsResult<unknown, readonly [typeof weatherTool]>>
    >();
    expect(isToolCallResult(finalResult)).toBe(true);
  });

  it('3. stream + conditional string tools -> StreamCallResult<string | CallWithToolsResult<string, Tools>>', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'sunny' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({
      userContent: 'hi',
      stream: true,
      tools,
      jsonMode: false,
    });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<
      StreamCallResult<string | CallWithToolsResult<string, NonNullable<typeof tools>>>
    >();
    expect(finalResult).toEqual({ type: 'content', content: 'sunny' });
  });

  it('4. stream + conditional tools, T pinned via schema -> StreamCallResult<T | CallWithToolsResult<T, Tools>>', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: '"sunny"' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({
      userContent: 'hi',
      stream: true,
      tools,
      jsonMode: true,
      schema: stringSchema,
    });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<
      StreamCallResult<string | CallWithToolsResult<string, NonNullable<typeof tools>>>
    >();
    expect(finalResult).toEqual({ type: 'content', content: 'sunny' });
  });

  it('5. stream + jsonMode: false, no tools -> StreamCallResult<string>', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'sunny' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', stream: true, jsonMode: false });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<StreamCallResult<string>>();
    expect(finalResult).toBe('sunny');
  });

  it('6. stream + jsonMode: true, no schema, no tools -> StreamCallResult<JsonValue>', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: '{"a":1}' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', stream: true, jsonMode: true });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<StreamCallResult<JsonValue>>();
    expect(finalResult).toEqual({ a: 1 });
  });

  it('7. stream, generic fallback -> StreamCallResult<T>', async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'text-delta', delta: '{"name":"Ada"}' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<{ name: string }>({
      userContent: 'hi',
      stream: true,
      jsonMode: true,
      schema: {
        safeParse: (d: unknown) => ({ success: true as const, data: d as { name: string } }),
      },
    });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<StreamCallResult<{ name: string }>>();
    expect(finalResult).toEqual({ name: 'Ada' });
  });

  it('7a. conditional stream + conditional tools -> ToolAwareResult<T, Tools> | StreamCallResult<ToolAwareResult<T, Tools>>', async () => {
    const wantsStream = (): boolean => true;
    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'sunny' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<string>({
      userContent: 'hi',
      stream: wantsStream(),
      tools,
      jsonMode: false,
    });

    // A plain typed assignment here (both directions) is a more reliable
    // equality check than `expectTypeOf().toEqualTypeOf()` for this shape:
    // narrowing via `isStreamResult` on a 3-way union leaves an un-distributed
    // intersection type that `expect-type`'s strict-equality branding doesn't
    // simplify, even though it's genuinely equal to the expected shape.
    type Expected = StreamCallResult<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >;
    expect(isStreamResult(result)).toBe(true);
    if (isStreamResult(result)) {
      const pinned: Expected = result;
      const _roundTrip: typeof result = pinned;
      await drain(pinned.chunks);
      expect(await pinned.finalResult).toEqual({ type: 'content', content: 'sunny' });
    }
  });

  it('7b. conditional stream, no tools -> T | StreamCallResult<T>', async () => {
    const wantsStream = (): boolean => true;

    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'sunny' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<string>({
      userContent: 'hi',
      stream: wantsStream(),
      jsonMode: false,
    });

    expectTypeOf(result).toEqualTypeOf<string | StreamCallResult<string>>();
    expect(isStreamResult(result)).toBe(true);
    if (isStreamResult(result)) {
      await drain(result.chunks);
      expect(await result.finalResult).toBe('sunny');
    }
  });

  it('7c. regression: a literal stream: false still resolves to plain string, not the conditional union', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    // No explicit `call<T>()` here: `jsonMode: false` alone already pins T=string
    // via `JsonModeDisabledCallParams`. See the note above `ConditionalStreamCallParams`
    // for why an explicit `<T>` combined with a literal `stream: false` doesn't hold
    // this guarantee.
    const result = await llm.call({ userContent: 'hi', stream: false, jsonMode: false });

    expectTypeOf(result).toEqualTypeOf<string>();
    expect(result).toBe('sunny');
  });

  it('7d. known limitation: explicit call<T>() plus a literal stream: false over-widens instead of narrowing', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    // TypeScript can't invert a conditional type to infer S once an explicit
    // type argument is given, so S falls back to its `boolean` default here,
    // matching the conditional overload even for a literal `false`. Safe
    // (never wrong at runtime, only ever too wide) but not exact.
    const result = await llm.call<string>({ userContent: 'hi', stream: false, jsonMode: false });

    expectTypeOf(result).toEqualTypeOf<string | StreamCallResult<string>>();
    expect(isStreamResult(result)).toBe(false);
    if (!isStreamResult(result)) {
      expect(result).toBe('sunny');
    }
  });

  it('8. no stream + tools disabled -> ContentResult<T>', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<string>({
      userContent: 'hi',
      tools: [weatherTool],
      toolChoice: 'none',
    });

    expectTypeOf(result).toEqualTypeOf<ContentResult<string>>();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('9. no stream + tools enabled -> CallWithToolsResult<T, Tools>', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', tools: [weatherTool] });

    expectTypeOf(result).toEqualTypeOf<
      CallWithToolsResult<unknown, readonly [typeof weatherTool]>
    >();
    expect(isToolCallResult(result)).toBe(true);
  });

  it('10. no stream + conditional string tools -> string | CallWithToolsResult<string, Tools>', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({ userContent: 'hi', tools, jsonMode: false });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('11. no stream + conditional tools, T pinned via schema -> T | CallWithToolsResult<T, Tools>', async () => {
    const { client } = createMockClient([jsonResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({
      userContent: 'hi',
      tools,
      jsonMode: true,
      schema: stringSchema,
    });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('12. jsonMode: false, no tools, no stream -> string', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expectTypeOf(result).toEqualTypeOf<string>();
    expect(result).toBe('sunny');
  });

  it('13. jsonMode: true, no schema, no tools, no stream -> JsonValue', async () => {
    const { client } = createMockClient([jsonResponse({ a: 1 })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', jsonMode: true });

    expectTypeOf(result).toEqualTypeOf<JsonValue>();
    expect(result).toEqual({ a: 1 });
  });

  it('14. generic fallback -> T', async () => {
    const { client } = createMockClient([jsonResponse({ name: 'Ada' })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<{ name: string }>({
      userContent: 'hi',
      jsonMode: true,
      schema: {
        safeParse: (d: unknown) => ({ success: true as const, data: d as { name: string } }),
      },
    });

    expectTypeOf(result).toEqualTypeOf<{ name: string }>();
    expect(result).toEqual({ name: 'Ada' });
  });
});

describe('cachedCall() overload matrix mirrors call()', () => {
  it('tools enabled -> CallWithToolsResult<T, Tools>', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.cachedCall({
      cacheKey: 'overload-matrix-tools',
      ttl: 60,
      call: { userContent: 'hi', tools: [weatherTool] },
    });

    expectTypeOf(result).toEqualTypeOf<
      CallWithToolsResult<unknown, readonly [typeof weatherTool]>
    >();
    expect(isToolCallResult(result)).toBe(true);
  });

  it('conditional tools -> union, narrowed the same way as call()', async () => {
    const { client } = createMockClient([jsonResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.cachedCall({
      cacheKey: 'overload-matrix-conditional',
      ttl: 60,
      call: { userContent: 'hi', tools, jsonMode: true, schema: stringSchema },
    });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('jsonMode: false, no tools -> string', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.cachedCall({
      cacheKey: 'overload-matrix-string',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false },
    });

    expectTypeOf(result).toEqualTypeOf<string>();
    expect(result).toBe('sunny');
  });

  it('stream: true, no tools, jsonMode: true -> StreamCallResult<JsonValue>', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: '{"a":1}' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.cachedCall({
      cacheKey: 'overload-matrix-stream-json',
      ttl: 60,
      call: { userContent: 'hi', stream: true, jsonMode: true },
    });
    await drain(result.chunks);
    const finalResult = await result.finalResult;

    expectTypeOf(result).toEqualTypeOf<StreamCallResult<JsonValue>>();
    expect(finalResult).toEqual({ a: 1 });
  });
});
