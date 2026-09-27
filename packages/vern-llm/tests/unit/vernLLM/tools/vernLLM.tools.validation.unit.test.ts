import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type CallParams,
  defineTool,
  hasIssues,
  isLLMError,
  isToolCallResult,
} from '../../../../src/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  drain,
  textResponse,
  toolCallResponse,
} from '../../../helpers.js';
import { weatherTool } from './vernLLM.tools.helpers.js';

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

  it('returns the argumentsSchema output as the tool call arguments, not the raw parsed arguments', async () => {
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
            city: 'NEW YORK',
          },
        },
      ],
    });
  });

  it('applies zod defaults, coercion and transforms per tool, leaving a tool without a schema as parsed', async () => {
    const searchTool = defineTool({
      name: 'search',
      description: 'Searches',
      parameters: { type: 'object' },
      argumentsSchema: z.object({
        query: z.string().transform((q) => q.trim()),
        limit: z.coerce.number().default(10),
      }),
    });
    const logTool = { name: 'log', description: 'Logs', parameters: { type: 'object' } };

    const { client } = createMockClient([
      toolCallResponse([
        { id: 'call_1', name: 'search', arguments: { query: '  cats  ' } },
        { id: 'call_2', name: 'search', arguments: { query: 'dogs', limit: '3' } },
        { id: 'call_3', name: 'log', arguments: { raw: ' kept ' } },
      ]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ userContent: 'hi', tools: [searchTool, logTool] });

    expect(result).toEqual({
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_1', name: 'search', arguments: { query: 'cats', limit: 10 } },
        { id: 'call_2', name: 'search', arguments: { query: 'dogs', limit: 3 } },
        { id: 'call_3', name: 'log', arguments: { raw: ' kept ' } },
      ],
    });
  });

  it('resolves a streamed finalResult with the argumentsSchema output', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_weather' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city":" denver "}' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });
    const trimmingTool = {
      ...weatherTool,
      argumentsSchema: z.object({ city: z.string().trim().toUpperCase() }),
    };

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      tools: [trimmingTool],
      stream: true,
    });
    await drain(chunks);

    expect(await finalResult).toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'DENVER' } }],
    });
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
    ).rejects.toMatchObject({ type: 'invalid_params' });
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
    ).rejects.toMatchObject({ type: 'invalid_params' });
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
    ).rejects.toMatchObject({
      type: 'invalid_params',
      message: expect.stringMatching(/duplicate/i),
    });
  });

  it('throws a clear error when the model requests a tool name that was not offered, and does not retry, since the wire request would repeat identically', async () => {
    const { client, create } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'not_a_real_tool', arguments: {} }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 3 });

    await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
      type: 'validation',
      code: 'unknown_tool',
      message: expect.stringContaining('not_a_real_tool'),
      issues: [{ name: 'not_a_real_tool', toolCallId: 'call_1', code: 'unknown_tool' }],
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
      type: 'validation',
      code: 'unknown_tool',
      issues: [
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
      type: 'validation',
      code: 'duplicate_tool_call_id',
      issues: [{ name: 'get_weather', toolCallId: 'call_1', code: 'duplicate_tool_call_id' }],
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
      type: 'validation',
      code: 'unknown_tool',
      issues: [
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
      { type: 'validation', code: undefined, issues: 'city must be a string' },
    );

    // Validation failures were never retryable, before or after this change.
    expect(create.mock.calls.length).toBe(1);
  });

  it('rejects toolChoice set without tools', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({ userContent: 'hi', toolChoice: 'required' } as CallParams<unknown>),
    ).rejects.toMatchObject({ type: 'invalid_params' });
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
    ).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'unknown_tool_choice',
      issues: { requested: 'not_a_real_tool', available: ['get_weather'] },
    });
  });

  it('rejects an empty tools array instead of silently switching on tool-call mode', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(llm.call({ userContent: 'hi', tools: [] })).rejects.toMatchObject({
      type: 'invalid_params',
    });
  });

  it('rejects tools with duplicate names', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.call({ userContent: 'hi', tools: [weatherTool, { ...weatherTool, description: 'dup' }] }),
    ).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'duplicate_tool_names',
      issues: { names: ['get_weather'] },
    });
  });

  it('narrows `issues` through `hasIssues` without a manual cast', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const err = (await llm
      .call({ userContent: 'hi', tools: [weatherTool, { ...weatherTool, description: 'dup' }] })
      .catch((e) => e)) as unknown;

    expect(isLLMError(err)).toBe(true);
    if (isLLMError(err) && hasIssues(err, 'duplicate_tool_names')) {
      // Type-level assertion: `err.issues.names` is `string[]` here with no cast.
      const names: string[] = err.issues.names;
      expect(names).toEqual(['get_weather']);
    } else {
      throw new Error('expected a duplicate_tool_names error');
    }
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
