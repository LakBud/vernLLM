import { describe, it, expect, expectTypeOf, vi } from 'vitest';

import { type AnthropicClient, type CallParams, isToolCallResult } from '../../src/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse, textResponse, toolCallResponse, at } from '../helpers.js';

const weatherTool = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

describe('VernLLM.call, happy paths', () => {
  it('returns a plain-text content result by default (jsonMode defaults to false when tools are set)', async () => {
    const { client } = createMockClient([textResponse('hi there')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      userContent: 'hello',
      tools: [weatherTool],
    });

    expect(result).toEqual({ type: 'content', content: 'hi there' });
  });

  it('still parses/validates JSON content when jsonMode is explicitly requested', async () => {
    const { client } = createMockClient([jsonResponse({ answer: 'hi' })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      userContent: 'hello',
      tools: [weatherTool],
      jsonMode: true,
    });

    expect(result).toEqual({ type: 'content', content: { answer: 'hi' } });
  });

  it('returns a tool_calls result, parsing arguments as JSON', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      userContent: 'what is the weather in New York?',
      tools: [weatherTool],
    });

    expect(result).toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }],
    });
  });

  it('carries accompanying text alongside a tool_calls result', async () => {
    const { client } = createMockClient([
      toolCallResponse(
        [{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }],
        'Let me check that for you.',
      ),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'weather?', tools: [weatherTool] });

    expect(result).toMatchObject({ type: 'tool_calls', content: 'Let me check that for you.' });
  });

  it('defaults jsonMode to false when tools are set, so response_format is omitted', async () => {
    const { client, calls } = createMockClient([textResponse('a plain text answer')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({ userContent: 'hi', tools: [weatherTool] });

    expect(at(calls, 0)).not.toHaveProperty('response_format');
  });

  it('sends tools in the OpenAI-shaped wire format', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({ userContent: 'hi', tools: [weatherTool] });

    expect(at(calls, 0).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: weatherTool.description,
          parameters: weatherTool.parameters,
        },
      },
    ]);
    expect(at(calls, 0).tool_choice).toBe('auto');
  });

  it('maps a `{ name }` toolChoice to the wire forced-function shape', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({
      userContent: 'hi',
      tools: [weatherTool],
      toolChoice: { name: 'get_weather' },
    });

    expect(at(calls, 0).tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('passes through string toolChoice values to the wire format', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({
      userContent: 'hi',
      tools: [weatherTool],
      toolChoice: 'required',
    });

    expect(at(calls, 0).tool_choice).toBe('required');

    await llm.call({
      userContent: 'hi',
      tools: [weatherTool],
      toolChoice: 'none',
    });

    expect(at(calls, 1).tool_choice).toBe('none');
  });

  it('toolChoice: "none" narrows call()\'s return type to ContentResult<T> alone', async () => {
    const { client } = createMockClient([textResponse('hi there')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call<string>({
      userContent: 'hi',
      tools: [weatherTool],
      toolChoice: 'none',
    });

    // Runtime: an ordinary content result, same shape as any non-tool call.
    expect(result).toEqual({ type: 'content', content: 'hi there' });

    // Compile-time: the actual point of this overload. `result.content` is
    // exactly `string` here (this call's own T), not the looser
    // `string | undefined` it would carry if TypeScript still had to
    // account for the tool_calls branch of the union (ToolCallResult's
    // `content?: string`). `toolCalls` isn't a field on this type at all.
    expectTypeOf(result).toEqualTypeOf<{ type: 'content'; content: string }>();
    expectTypeOf(result.content).toEqualTypeOf<string>();
  });
});

describe('VernLLM.call, multi-turn continuation via history', () => {
  it('forwards ToolResult.isError to Anthropic as tool_result.is_error', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    const { fromAnthropic } = await import('../../src/adapters/index.js');

    const llm = new VernLLM({
      client: fromAnthropic({ messages: { create } } as AnthropicClient),
      model: 'm',
    });

    await llm.call({
      userContent: 'retry that',
      tools: [weatherTool],
      history: [
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }],
        },
        {
          role: 'tool',
          toolResults: [{ toolCallId: 'call_1', content: 'city not found', isError: true }],
        },
      ],
    });

    const [params] = at(create.mock.calls, 0);

    expect(params.messages).toContainEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'city not found',
          is_error: true,
        },
      ],
    });
  });

  it('replays a prior tool_calls turn and its results as wire messages', async () => {
    const { client, calls } = createMockClient([jsonResponse({ answer: 'sunny' })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({
      userContent: 'what is the weather in New York?',
      tools: [weatherTool],
      history: [
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }],
        },
        {
          role: 'tool',
          toolResults: [{ toolCallId: 'call_1', content: { tempC: 21 } }],
        },
      ],
    });

    expect(at(calls, 0).messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ tempC: 21 }) },
      { role: 'user', content: 'what is the weather in New York?' },
    ]);
  });

  it('rejects a "tool" history turn that does not follow an assistant tool-call turn', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({
        userContent: 'hi',
        tools: [weatherTool],
        history: [
          { role: 'user', content: 'earlier message' },
          { role: 'tool', toolResults: [{ toolCallId: 'call_1', content: 'x' }] },
        ],
      }),
    ).rejects.toMatchObject({ type: 'validation' });
  });
});

describe('VernLLM.call, validation', () => {
  it(
    'no longer rejects tools combined with jsonSchema at the orchestration layer: Anthropic and ' +
      'Bedrock now support sending both in one request on models with native structured output, so ' +
      'this is left to each adapter (which knows its own model-capability list) rather than being ' +
      'a blanket rejection here',
    async () => {
      const { client } = createMockClient([textResponse('{"a":1}')]);
      const llm = new VernLLM({ client, model: 'test-model' });

      await expect(
        llm.call({
          userContent: 'hi',
          tools: [weatherTool],
          jsonSchema: { name: 'out', schema: { type: 'object' } },
        }),
      ).resolves.toMatchObject({ type: 'content', content: { a: 1 } });
    },
  );

  it('validates tool call arguments against argumentsSchema when provided', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 42 } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const strictWeatherTool = {
      ...weatherTool,
      argumentsSchema: {
        safeParse: (data: unknown) => {
          const city = (data as { city?: unknown })?.city;
          return typeof city === 'string'
            ? { success: true as const, data }
            : { success: false as const, error: 'city must be a string' };
        },
      },
    };

    await expect(llm.call({ userContent: 'hi', tools: [strictWeatherTool] })).rejects.toMatchObject(
      { type: 'validation' },
    );
  });

  it('returns tool call arguments after argumentsSchema validation succeeds', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }]),
    ]);

    const llm = new VernLLM({ client, model: 'test-model' });

    const safeParse = vi.fn(() => ({
      success: true as const,
      data: {
        city: 'NEW YORK',
      },
    }));

    const strictWeatherTool = {
      ...weatherTool,
      argumentsSchema: {
        safeParse,
      },
    };

    const result = await llm.call({
      userContent: 'hi',
      tools: [strictWeatherTool],
    });

    expect(safeParse).toHaveBeenCalledWith({ city: 'New York' });

    expect(result).toEqual({
      type: 'tool_calls',
      toolCalls: [
        {
          id: 'call_1',
          name: 'get_weather',
          arguments: {
            city: 'New York',
          },
        },
      ],
    });
  });
});

describe('VernLLM.cachedCall, tools', () => {
  it('caches a content result and skips a second call on a hit', async () => {
    const { client, create } = createMockClient([
      jsonResponse({ answer: 'hi' }),
      textResponse('should not be used'),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const params = {
      cacheKey: 'weather-1',
      ttl: 60,
      call: { userContent: 'hi', tools: [weatherTool], jsonMode: true },
    };

    const first = await llm.cachedCall(params);
    const second = await llm.cachedCall(params);

    expect(first).toEqual({ type: 'content', content: { answer: 'hi' } });
    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('caches a tool_calls result too (whole CallWithToolsResult is cached)', async () => {
    const { client, create } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const params = {
      cacheKey: 'weather-2',
      ttl: 60,
      call: { userContent: 'weather in New York?', tools: [weatherTool] },
    };

    const first = await llm.cachedCall(params);
    const second = await llm.cachedCall(params);

    expect(first).toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }],
    });
    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reserves and refunds exactly once using top-level hooks', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const { client } = createMockClient([new Error('fail')]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await llm
      .cachedCall({
        cacheKey: 'k',
        ttl: 60,
        call: { userContent: 'hi', tools: [weatherTool] },
        reserveUsage,
        refundUsage,
      })
      .catch(() => {});

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call, bug fixes / hardening', () => {
  it('rejects a "tool" history turn that follows a plain assistant turn without toolCalls', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({
        userContent: 'hi',
        tools: [weatherTool],
        history: [
          { role: 'assistant', content: 'plain reply, no tool calls' },
          { role: 'tool', toolResults: [{ toolCallId: 'x', content: 'y' }] },
        ],
      }),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('rejects a "tool" history turn whose toolResults reference an unknown toolCallId', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({
        userContent: 'hi',
        tools: [weatherTool],
        history: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }],
          },
          { role: 'tool', toolResults: [{ toolCallId: 'call_WRONG', content: 'y' }] },
        ],
      }),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('rejects a duplicate toolCallId in toolResults, even when every requested id has a known match', async () => {
    // Regression: two results for call_1 and zero for call_2 both count as
    // "known" ids, so without an explicit duplicate check this could slip
    // past validation while call_2 is silently left unresolved.
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({
        userContent: 'hi',
        tools: [weatherTool],
        history: [
          {
            role: 'assistant',
            toolCalls: [
              { id: 'call_1', name: 'get_weather', arguments: {} },
              { id: 'call_2', name: 'get_weather', arguments: {} },
            ],
          },
          {
            role: 'tool',
            toolResults: [
              { toolCallId: 'call_1', content: 'x' },
              { toolCallId: 'call_1', content: 'x again' },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ type: 'validation', message: expect.stringMatching(/duplicate/i) });
  });

  it('throws a clear error when the model requests a tool name that was not offered, and does not retry, since the wire request would repeat identically', async () => {
    const { client, create } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'not_a_real_tool', arguments: {} }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 3 });

    await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
      type: 'api',
      code: 'unknown_tool',
      message: expect.stringContaining('not_a_real_tool'),
      toolIssues: [{ name: 'not_a_real_tool', toolCallId: 'call_1', code: 'unknown_tool' }],
    });

    // Guards the retry-classification fix: even with retries configured,
    // this is a defect that repeats byte-for-byte, so only one request
    // should ever have reached the client.
    expect(create.mock.calls.length).toBe(1);
  });

  it('aggregates every unknown tool name across a multi-call response into one error', async () => {
    const { client } = createMockClient([
      toolCallResponse([
        { id: 'call_1', name: 'not_real_1', arguments: {} },
        { id: 'call_2', name: 'get_weather', arguments: { city: 'NYC' } },
        { id: 'call_3', name: 'not_real_2', arguments: {} },
      ]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
      type: 'api',
      code: 'unknown_tool',
      toolIssues: [
        { name: 'not_real_1', toolCallId: 'call_1', code: 'unknown_tool' },
        { name: 'not_real_2', toolCallId: 'call_3', code: 'unknown_tool' },
      ],
    });
  });

  it("rejects a duplicate toolCallId among the model's own tool_calls, and does not retry", async () => {
    const { client, create } = createMockClient([
      toolCallResponse([
        { id: 'call_1', name: 'get_weather', arguments: { city: 'NYC' } },
        { id: 'call_1', name: 'get_weather', arguments: { city: 'LA' } },
      ]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 3 });

    await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
      type: 'api',
      code: 'duplicate_tool_call_id',
      toolIssues: [{ name: 'get_weather', toolCallId: 'call_1', code: 'duplicate_tool_call_id' }],
    });

    expect(create.mock.calls.length).toBe(1);
  });

  it('aggregates unknown-tool and duplicate toolCallId issues from one multi-call response and does not retry', async () => {
    const { client, create } = createMockClient([
      toolCallResponse([
        { id: 'call_1', name: 'not_a_real_tool', arguments: {} },
        { id: 'call_1', name: 'get_weather', arguments: { city: 'NYC' } },
      ]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 3 });

    await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
      type: 'api',
      code: 'unknown_tool',
      toolIssues: [
        { name: 'not_a_real_tool', toolCallId: 'call_1', code: 'unknown_tool' },
        { name: 'get_weather', toolCallId: 'call_1', code: 'duplicate_tool_call_id' },
      ],
    });

    expect(create.mock.calls.length).toBe(1);
  });

  it('still reports a schema-validation failure as type "validation" (unchanged, single-error) when there is no contract failure', async () => {
    const { client, create } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 42 } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 3 });

    const strictWeatherTool = {
      ...weatherTool,
      argumentsSchema: {
        safeParse: (data: unknown) => {
          const city = (data as { city?: unknown })?.city;
          return typeof city === 'string'
            ? { success: true as const, data }
            : { success: false as const, error: 'city must be a string' };
        },
      },
    };

    await expect(llm.call({ userContent: 'hi', tools: [strictWeatherTool] })).rejects.toMatchObject(
      { type: 'validation', code: undefined, toolIssues: undefined },
    );

    // Validation failures were never retryable, before or after this change.
    expect(create.mock.calls.length).toBe(1);
  });

  it('rejects toolChoice set without tools', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({ userContent: 'hi', toolChoice: 'required' } as CallParams<unknown>),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('rejects toolChoice naming a tool that is not in tools', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({
        userContent: 'hi',
        tools: [weatherTool],
        toolChoice: { name: 'not_a_real_tool' },
      }),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('rejects an empty tools array instead of silently switching on tool-call mode', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(llm.call({ userContent: 'hi', tools: [] })).rejects.toMatchObject({
      type: 'validation',
    });
  });

  it('rejects tools with duplicate names', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({ userContent: 'hi', tools: [weatherTool, { ...weatherTool, description: 'dup' }] }),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('isToolCallResult() narrows a tool_calls result and rejects a content result', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'weather?', tools: [weatherTool] });

    expect(isToolCallResult(result)).toBe(true);
    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]!.name).toBe('get_weather');
    }
  });

  it('isToolCallResult() returns false for a plain content result', async () => {
    const { client } = createMockClient([textResponse('hi there')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', tools: [weatherTool] });

    expect(isToolCallResult(result)).toBe(false);
  });
});
