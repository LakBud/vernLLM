import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromAnthropic } from '../../../../src/adapters/claude/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, drain } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

// `fromAnthropic` accepts a real `Anthropic` client instance directly, no
// wrapper or cast needed: `AnthropicClient`'s TS types now match the real
// SDK's own generated types closely enough (narrowed `media_type`, a
// proper discriminated `tool_choice` union, and `input_schema: { type:
// 'object' }`) that `fromAnthropic(anthropic)` just type-checks.

/**
 * Exercises `fromAnthropic` against a *real* `@anthropic-ai/sdk` client
 * instance, pointed at a local mock server instead of `api.anthropic.com`.
 * Unlike `anthropic.int.test.ts` (which hand-rolls a fake `{ messages: {
 * create } }` object), this proves the adapter's structural `AnthropicClient`
 * type actually matches what the real SDK sends/returns on the wire, that
 * `messages.create` really is callable the way the adapter calls it, and
 * that the SDK's real response objects parse the way the adapter expects.
 */
describe('Anthropic adapter integration (real @anthropic-ai/sdk client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('drives a real Anthropic SDK client through VernLLM.call end to end', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Paris is the capital of France.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 24, output_tokens: 9 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are a helpful geography assistant.',
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris is the capital of France.');

    const sent = at(server.requests, 0);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('test-key');
    expect(sent.body).toMatchObject({
      model: 'claude-test',
      system: 'You are a helpful geography assistant.',
      messages: [{ role: 'user', content: "What's the capital of France?" }],
    });
  });

  it('forces real tool-use for json_schema structured output and unwraps the real SDK response', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_02',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Summary',
              input: { headline: 'Real SDK works', score: 9 },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 30, output_tokens: 12 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });
    const client = fromAnthropic(anthropic);

    const result = await client.chat.completions.create(
      {
        model: 'claude-test',
        temperature: 0.2,
        max_tokens: 200,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Summary',
            schema: {
              type: 'object',
              properties: { headline: { type: 'string' }, score: { type: 'number' } },
              required: ['headline', 'score'],
            },
          },
        },
        messages: [{ role: 'user', content: 'Summarize the test results.' }],
      },
      { signal: new AbortController().signal },
    );

    expect(JSON.parse(result.choices?.[0]?.message?.content ?? '')).toEqual({
      headline: 'Real SDK works',
      score: 9,
    });
    expect(result.usage).toEqual({
      prompt_tokens: 30,
      completion_tokens: 12,
      total_tokens: 42,
      prompt_tokens_details: {},
    });

    const sent = at(server.requests, 0);
    expect(sent.body).toMatchObject({
      tools: [expect.objectContaining({ name: 'Summary' })],
      tool_choice: { type: 'tool', name: 'Summary' },
    });
  });

  it(
    'sends jsonSchema as output_config.format alongside real tools against a real Anthropic ' +
      'SDK client, on a model covered by nativeStructuredOutputModels',
    async () => {
      server = await startRealSdkServer([
        {
          body: {
            id: 'msg_native',
            type: 'message',
            role: 'assistant',
            model: 'claude-native-test',
            content: [{ type: 'text', text: '{"headline":"Native works","score":10}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 28, output_tokens: 11 },
          },
        },
      ]);

      const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });
      const client = fromAnthropic(anthropic, {
        nativeStructuredOutputModels: ['claude-native-test'],
      });

      const result = await client.chat.completions.create(
        {
          model: 'claude-native-test',
          max_tokens: 200,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'Summary',
              schema: {
                type: 'object',
                properties: { headline: { type: 'string' }, score: { type: 'number' } },
                required: ['headline', 'score'],
              },
            },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_context',
                description: 'Fetches additional context',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          messages: [{ role: 'user', content: 'Summarize the test results.' }],
        },
        { signal: new AbortController().signal },
      );

      expect(JSON.parse(result.choices?.[0]?.message?.content ?? '')).toEqual({
        headline: 'Native works',
        score: 10,
      });

      // Real SDK, real wire body: output_config.format has only type and
      // schema, no name/description/strict, matching the real Anthropic
      // API exactly (unlike the legacy forced-tool-call path above, where
      // the schema becomes a real `Tool` with those fields). Real `tools`
      // are sent unmodified in the normal `tools` field, alongside it, not
      // instead of it.
      const sent = at(server.requests, 0);
      expect(sent.body).toMatchObject({
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { headline: { type: 'string' }, score: { type: 'number' } },
              required: ['headline', 'score'],
            },
          },
        },
        tools: [expect.objectContaining({ name: 'get_context' })],
      });
      expect(
        (sent.body as { output_config: { format: object } }).output_config.format,
      ).not.toHaveProperty('name');
    },
  );

  it('surfaces a real Anthropic SDK error (429) through VernLLM retry handling', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        body: {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limited by mock server' },
        },
      },
      {
        body: {
          id: 'msg_03',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'ok after retry' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
      maxRetries: 1,
      baseDelayMs: 1,
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('ok after retry');
    expect(server.requests.length).toBe(2);
  });

  it('passes real multimodal image content through to the Anthropic SDK', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_04',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'I see a small red square.' }],
          usage: { input_tokens: 40, output_tokens: 8 },
        },
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const result = await llm.call({
      userContent: [
        { type: 'text', text: "What's in this image?" },
        { type: 'image', data: 'ZmFrZWJhc2U2NA==', mimeType: 'image/png' },
      ],
      jsonMode: false,
    });

    expect(result).toBe('I see a small red square.');

    const sent = at(server.requests, 0);
    expect(sent.body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZWJhc2U2NA==' },
            },
          ],
        },
      ],
    });
  });

  it('streams live text-delta chunks from a real Anthropic SSE response and resolves finalResult', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            event: 'message_start',
            data: { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello, ' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'world!' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
      },
    ]);

    await expect(finalResult).resolves.toBe('Hello, world!');
  });

  it('honors an aborted signal against a real Anthropic SDK client mid-request', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const anthropic = new Anthropic({
      apiKey: 'test-key',
      baseURL: server.url,
      maxRetries: 0,
    });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
      maxRetries: 0,
    });

    const controller = new AbortController();
    const callPromise = llm.call({
      userContent: 'hi',
      jsonMode: false,
      signal: controller.signal,
    });

    // Wait until the mock server has recorded the request so the abort
    // happens while the real SDK request is genuinely in flight.
    await vi.waitUntil(() => (server?.requests.length ?? 0) > 0);
    controller.abort();

    await expect(callPromise).rejects.toMatchObject({
      name: 'LLMError',
      type: 'aborted',
    });
  });

  it('reports a timeout against a real Anthropic SDK client that never responds', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
      maxRetries: 0,
      timeoutMs: 100,
    });

    // The SDK throws its own abort error type here, not a DOMException, so
    // this guards that it still surfaces as a timeout rather than 'unknown'.
    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      name: 'LLMError',
      type: 'timeout',
      code: 'request_timeout',
    });
  });
});

describe('Anthropic adapter integration, thinking, caching and forced tool_choice (real SDK)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const weatherTool = {
    name: 'get_weather',
    description: 'Gets the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  };

  const message = (content: unknown[], usage: Record<string, number> = {}) => ({
    body: {
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, ...usage },
    },
  });

  it('carries thinking blocks through a real tool loop, sent back ahead of the tool_use', async () => {
    server = await startRealSdkServer([
      message([
        { type: 'thinking', thinking: 'need weather', signature: 'sig-abc' },
        { type: 'redacted_thinking', data: 'enc-xyz' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } },
      ]),
      message([{ type: 'text', text: 'It is sunny.' }]),
    ]);
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-test',
    });

    const first = await llm.call({
      userContent: 'Weather in Oslo?',
      tools: [weatherTool],
      budgetTokens: 2000,
      maxTokens: 4000,
    });
    if (first.type !== 'tool_calls') throw new Error('expected a tool call');

    expect(first.thinking).toEqual([
      { type: 'thinking', thinking: 'need weather', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'enc-xyz' },
    ]);

    await llm.call({
      userContent: 'Weather in Oslo?',
      tools: [weatherTool],
      budgetTokens: 2000,
      maxTokens: 4000,
      jsonMode: false,
      history: [
        { role: 'assistant', toolCalls: first.toolCalls, thinking: first.thinking },
        { role: 'tool', toolResults: [{ toolCallId: 'toolu_1', content: 'sunny' }] },
      ],
    });

    const sent = at(server.requests, 1).body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(sent.messages.find((m) => m.role === 'assistant')?.content).toEqual([
      { type: 'thinking', thinking: 'need weather', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'enc-xyz' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } },
    ]);
  });

  it('assembles streamed thinking and signature deltas onto finalResult, never onto chunks', async () => {
    const event = (data: { type: string }) => ({ event: data.type, data });
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          event({ type: 'message_start', message: { usage: { input_tokens: 10 } } } as never),
          event({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          } as never),
          event({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'need ' },
          } as never),
          event({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'weather' },
          } as never),
          event({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig-abc' },
          } as never),
          event({ type: 'content_block_stop', index: 0 } as never),
          event({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
          } as never),
          event({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' },
          } as never),
          event({ type: 'content_block_stop', index: 1 } as never),
          event({ type: 'message_delta', usage: { output_tokens: 5 } } as never),
          event({ type: 'message_stop' }),
        ]),
      },
    ]);
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-test',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'Weather in Oslo?',
      tools: [weatherTool],
      budgetTokens: 2000,
      maxTokens: 4000,
      stream: true,
    });
    const collected = await drain(chunks);

    expect(collected.map((chunk) => chunk.type)).not.toContain('thinking_block');
    await expect(finalResult).resolves.toMatchObject({
      type: 'tool_calls',
      thinking: [{ type: 'thinking', thinking: 'need weather', signature: 'sig-abc' }],
    });
  });

  it('counts real cache reads and writes in usage, but leaves reads out of the rate limiter', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_c',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'cached' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 8000,
            cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
            output_tokens: 5,
          },
        },
      },
    ]);
    const onUsage = vi.fn();
    const release = vi.fn();
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-test',
      onUsage,
      rateLimit: {
        estimate: () => 50,
        acquire: async () => ({ release, waitedMs: 0 }),
        signalRateLimit: () => {},
        reactToRateLimitHint: () => {},
      },
    });

    await llm.call({ userContent: 'hi', jsonMode: false });

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 10010,
        completionTokens: 5,
        totalTokens: 10015,
        cacheReadTokens: 8000,
        cacheWriteTokens: 2000,
        cacheWriteTokensByTtl: { '5m': 1500, '1h': 500 },
      }),
    );
    // Anthropic's input rate limit skips cache reads, so 8000 of the 10015 are not released.
    expect(release).toHaveBeenCalledWith(2015, true);
  });

  it('counts streamed cache reads and writes in usage, but leaves reads out of the rate limiter', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 10,
                  cache_creation_input_tokens: 2000,
                  cache_read_input_tokens: 8000,
                  cache_creation: {
                    ephemeral_5m_input_tokens: 1500,
                    ephemeral_1h_input_tokens: 500,
                  },
                },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'cached' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      },
    ]);
    const onUsage = vi.fn();
    const release = vi.fn();
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-test',
      onUsage,
      rateLimit: {
        estimate: () => 50,
        acquire: async () => ({ release, waitedMs: 0 }),
        signalRateLimit: () => {},
        reactToRateLimitHint: () => {},
      },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    await drain(chunks);
    await finalResult;

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 10010,
        completionTokens: 5,
        totalTokens: 10015,
        cacheReadTokens: 8000,
        cacheWriteTokens: 2000,
        cacheWriteTokensByTtl: { '5m': 1500, '1h': 500 },
      }),
    );
    expect(release).toHaveBeenCalledWith(2015, true);
  });

  it('takes the cumulative input totals from a real message_delta over message_start', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'cached' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              usage: {
                output_tokens: 5,
                input_tokens: 10,
                cache_creation_input_tokens: 2000,
                cache_read_input_tokens: 8000,
              },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      },
    ]);
    const onUsage = vi.fn();
    const release = vi.fn();
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-test',
      onUsage,
      rateLimit: {
        estimate: () => 50,
        acquire: async () => ({ release, waitedMs: 0 }),
        signalRateLimit: () => {},
        reactToRateLimitHint: () => {},
      },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    await drain(chunks);
    await finalResult;

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 10010,
        totalTokens: 10015,
        cacheReadTokens: 8000,
        cacheWriteTokens: 2000,
      }),
    );
    expect(release).toHaveBeenCalledWith(2015, true);
  });

  it('rejects a forced tool_choice on a model that refuses it without sending anything', async () => {
    server = await startRealSdkServer([message([{ type: 'text', text: 'never' }])]);
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-opus-5-5',
      maxRetries: 2,
    });

    await expect(
      llm.call({ userContent: 'hi', tools: [weatherTool], toolChoice: 'required' }),
    ).rejects.toMatchObject({ type: 'invalid_params', code: 'unsupported_capability' });
    expect(server.requests).toHaveLength(0);
  });

  it('sends jsonSchema as native output_config on a model that refuses forced tool_choice', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'msg_n',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [{ type: 'text', text: '{"headline":"ok"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    const llm = new VernLLM({
      client: fromAnthropic(new Anthropic({ apiKey: 'test-key', baseURL: server.url })),
      model: 'claude-fable-5-1',
    });

    await expect(
      llm.call({
        userContent: 'Summarize',
        jsonSchema: {
          name: 'Summary',
          schema: { type: 'object', properties: { headline: { type: 'string' } } },
        },
      }),
    ).resolves.toEqual({ headline: 'ok' });

    const sent = at(server.requests, 0).body as Record<string, unknown>;
    expect(sent.output_config).toMatchObject({ format: { type: 'json_schema' } });
    expect(sent).not.toHaveProperty('tool_choice');
  });
});
