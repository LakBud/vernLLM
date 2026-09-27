import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  type CallWithToolsResult,
  defineCachedCallParams,
  defineCallParams,
  isToolCallResult,
} from '../../../../src/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  drain,
  jsonResponse,
  textResponse,
  toolCallResponse,
} from '../../../helpers.js';
import { stringSchema, weatherTool } from './vernLLM.tools.helpers.js';

describe('VernLLM.call, conditionally-set tools', () => {
  // Before ConditionalToolCallParams, tools: ToolDefinition[] | undefined
  // matched no overload and fell through to plain CallParams<T>, typing a
  // tool_calls response as plain content.

  it('call(): tool_calls response types as the union and narrows via isToolCallResult()', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({
      userContent: 'weather?',
      tools,
      jsonMode: true,
      schema: stringSchema,
    });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('call(): tools resolving to undefined at runtime behaves like the no-tools path', async () => {
    // tools is undefined here both statically and at runtime, so the
    // real result is the raw T, not a wrapped ContentResult.
    const { client } = createMockClient([jsonResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = false;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({ userContent: 'weather?', tools });

    expect(isToolCallResult(result)).toBe(false);
    expect(result).toBe('sunny');
  });

  it('call(): jsonMode false infers string content with conditional tools', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.call({
      userContent: 'weather?',
      tools,
      jsonMode: false,
    });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('call(): omitting tools resolves to plain T, not the union', async () => {
    const { client } = createMockClient([jsonResponse('hi there')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi' });

    expectTypeOf(result).toEqualTypeOf<unknown>();
    expect(result).toBe('hi there');
  });

  it('call(): stream: true with conditional tools resolves finalResult to the union', async () => {
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

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const { finalResult, chunks } = await llm.call({
      userContent: 'weather?',
      tools,
      stream: true,
      jsonMode: true,
      schema: stringSchema,
    });
    await drain(chunks);
    const result = await finalResult;

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('call(): stream: true with jsonMode false infers string content with conditional tools', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'sunny' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const { finalResult, chunks } = await llm.call({
      userContent: 'weather?',
      tools,
      stream: true,
      jsonMode: false,
    });
    await drain(chunks);
    const result = await finalResult;

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('cachedCall(): tool_calls response types as the union', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.cachedCall({
      cacheKey: 'conditional-tools-1',
      ttl: 60,
      call: { userContent: 'weather?', tools, jsonMode: true, schema: stringSchema },
    });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('cachedCall(): jsonMode false infers string content with conditional tools', async () => {
    const { client } = createMockClient([textResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const result = await llm.cachedCall({
      cacheKey: 'conditional-tools-json-mode-false',
      ttl: 60,
      call: {
        userContent: 'weather?',
        tools,
        jsonMode: false,
      },
    });

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(result).toEqual({ type: 'content', content: 'sunny' });
  });

  it('cachedCall(): stream: true with conditional tools resolves finalResult to the union', async () => {
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

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const { finalResult, chunks } = await llm.cachedCall({
      cacheKey: 'conditional-tools-2',
      ttl: 60,
      call: { userContent: 'weather?', tools, stream: true, jsonMode: true, schema: stringSchema },
    });
    await drain(chunks);
    const result = await finalResult;

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('cachedCall(): stream: true with jsonMode false infers string content with conditional tools', async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'The weather is clear.' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [weatherTool] : undefined;

    const { finalResult, chunks } = await llm.cachedCall({
      cacheKey: 'conditional-tools-json-mode-false',
      ttl: 60,
      call: { userContent: 'weather?', tools, stream: true, jsonMode: false },
    });
    await drain(chunks);
    const result = await finalResult;

    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof tools>>
    >();
  });
});

describe('defineCallParams / defineCachedCallParams', () => {
  // Pure identity functions at runtime. Coverage here is mostly
  // type-level, plus a runtime check that values pass through unchanged.

  it('literal tools array still resolves CallWithToolsResult<T> directly', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const params = defineCallParams({ userContent: 'weather?', tools: [weatherTool] });

    const result = await llm.call(params);
    expectTypeOf(result).toEqualTypeOf<CallWithToolsResult<unknown, typeof params.tools>>();
    expect(isToolCallResult(result)).toBe(true);
  });

  it('preserves conditional tools through a named variable, resolving the union', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const params = defineCallParams({
      userContent: 'weather?',
      tools: useTool ? [weatherTool] : undefined,
      jsonMode: true,
      schema: stringSchema,
    });

    const result = await llm.call(params);
    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof params.tools>>
    >();
    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('T is pinned at the call<T>() site, same as passing an object inline', async () => {
    const { client } = createMockClient([jsonResponse('hi there')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = false;
    const params = defineCallParams({
      userContent: 'hi',
      tools: useTool ? [weatherTool] : undefined,
    });

    const result = await llm.call<string>(params);
    expectTypeOf(result).toEqualTypeOf<string | CallWithToolsResult<string>>();
    expect(isToolCallResult(result)).toBe(false);
  });

  it('defineCachedCallParams preserves conditional tools nested in call, resolving the union', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const params = defineCachedCallParams({
      cacheKey: 'define-cached-params-1',
      ttl: 60,
      call: {
        userContent: 'weather?',
        tools: useTool ? [weatherTool] : undefined,
        jsonMode: true,
        schema: stringSchema,
      },
    });

    const result = await llm.cachedCall(params);
    expectTypeOf(result).toEqualTypeOf<
      string | CallWithToolsResult<string, NonNullable<typeof params.call.tools>>
    >();
    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    } else {
      throw new Error('expected a tool_calls result');
    }
  });
});
