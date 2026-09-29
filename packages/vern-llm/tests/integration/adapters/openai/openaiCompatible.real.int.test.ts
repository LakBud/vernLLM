import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromGroq, fromOpenAICompatible } from '../../../../src/adapters/openai/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, drain } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * Exercises `fromOpenAICompatible` against a real `openai` SDK client and
 * `fromGroq` against a real `groq-sdk` client, both pointed at a local mock
 * server instead of their real provider APIs.
 *
 * Unlike `openaiCompatible.int.test.ts` (a hand-rolled fake
 * `{ chat: { completions: { create } } }`), these tests prove the real SDK's
 * request/response objects actually satisfy the adapter's assumed wire shape.
 */
describe('OpenAI-compatible adapter integration (real SDK clients)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('drives a real OpenAI SDK client through VernLLM.call end to end', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1234567890,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Paris is the capital of France.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
          },
        },
      },
    ]);

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${server.url}/v1`,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are a helpful geography assistant.',
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris is the capital of France.');

    const sent = at(server.requests, 0);

    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer test-key');
    expect(sent.body).toMatchObject({
      model: 'gpt-test',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful geography assistant.',
        },
        {
          role: 'user',
          content: "What's the capital of France?",
        },
      ],
    });
  });

  it('sends real tool_calls round-trip through the fromGroq alias using the real Groq SDK', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'chatcmpl-2',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'getWeather',
                      arguments: '{"city":"Paris"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 10,
            total_tokens: 25,
          },
        },
      },
    ]);

    const groq = new Groq({
      apiKey: 'test-key',
      baseURL: server.url,
    });

    // Exercise the provider-specific alias with the actual Groq SDK client.
    const client = fromGroq(groq);

    const result = await client.chat.completions.create(
      {
        model: 'gpt-test',
        temperature: 0,
        max_tokens: 100,
        tools: [
          {
            type: 'function',
            function: {
              name: 'getWeather',
              description: 'Gets the weather for a city',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                },
                required: ['city'],
              },
            },
          },
        ],
        messages: [
          {
            role: 'user',
            content: "What's the weather in Paris?",
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'getWeather',
          arguments: '{"city":"Paris"}',
        },
      },
    ]);

    const sent = at(server.requests, 0);

    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/openai/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer test-key');
    expect(sent.body).toMatchObject({
      model: 'gpt-test',
      tools: [
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'getWeather',
          }),
        }),
      ],
    });
  });

  function completionBody(content: string) {
    return {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    };
  }

  function makeLLM(model: string) {
    if (!server) throw new Error('server not started');
    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` });
    return new VernLLM({ client: fromOpenAICompatible(openai), model });
  }

  it('adds the word json to a default jsonMode call that never mentions it', async () => {
    server = await startRealSdkServer([{ body: completionBody('{"colors":["red"]}') }]);

    const result = await makeLLM('gpt-test').call({
      systemPrompt: 'You are helpful.',
      userContent: 'List one color.',
    });

    expect(result).toEqual({ colors: ['red'] });

    // OpenAI returns a 400 for json_object unless "json" appears in messages.
    const sentBody = at(server.requests, 0).body as {
      response_format: unknown;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(sentBody.messages.some((m) => /json/i.test(String(m.content)))).toBe(true);
  });

  it('sends max_completion_tokens and no temperature to a real reasoning model request', async () => {
    server = await startRealSdkServer([{ body: completionBody('Paris.') }]);

    await makeLLM('gpt-6-sol').call({
      userContent: "What's the capital of France?",
      jsonMode: false,
      maxTokens: 1000,
    });

    const sentBody = at(server.requests, 0).body as Record<string, unknown>;
    expect(sentBody).toMatchObject({ model: 'gpt-6-sol', max_completion_tokens: 1000 });
    expect(sentBody).not.toHaveProperty('max_tokens');
    expect(sentBody).not.toHaveProperty('temperature');
  });

  const lookupTool = {
    name: 'lookup',
    description: 'Looks something up',
    parameters: { type: 'object', properties: {} },
  };

  it('sends reasoning_effort none with tools to a real GPT-6 request', async () => {
    server = await startRealSdkServer([{ body: completionBody('Done.') }]);

    await makeLLM('gpt-6-sol').call({
      userContent: 'Look it up.',
      tools: [lookupTool],
      jsonMode: false,
    });

    const sentBody = at(server.requests, 0).body as Record<string, unknown>;
    expect(sentBody).toMatchObject({ model: 'gpt-6-sol', reasoning_effort: 'none' });
    expect(sentBody.tools).toHaveLength(1);
  });

  it('refuses GPT-6 tools with reasoning asked for, without a request reaching the server', async () => {
    server = await startRealSdkServer([{ body: completionBody('never') }]);

    await expect(
      makeLLM('gpt-6-sol').call({
        userContent: 'Look it up.',
        tools: [lookupTool],
        reasoningEffort: 'high',
      }),
    ).rejects.toMatchObject({ type: 'invalid_params', code: 'unsupported_capability' });
    expect(server.requests).toHaveLength(0);
  });

  it('reads the provider off a real OpenAI client, and none off a local baseURL', async () => {
    server = await startRealSdkServer([{ body: completionBody('ok') }]);
    const adapters: unknown[] = [];
    const observe = {
      dispatch: async (_request: unknown, next: () => Promise<void>, ctx: { adapter: unknown }) => {
        adapters.push(ctx.adapter);
        await next();
      },
    };

    const local = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` });
    await new VernLLM({
      client: fromOpenAICompatible(local),
      model: 'gpt-test',
      middleware: [observe],
    }).call({ userContent: 'hi', jsonMode: false });

    expect(adapters).toEqual([{ name: 'openai-compatible' }]);
    expect(fromOpenAICompatible(new OpenAI({ apiKey: 'test-key' })).adapter).toEqual({
      name: 'openai-compatible',
      provider: 'openai',
    });
    expect(fromGroq(new Groq({ apiKey: 'test-key' })).adapter).toEqual({
      name: 'openai-compatible',
      provider: 'groq',
    });
  });

  it('keeps a failed tool result visible to the model through the real SDK', async () => {
    server = await startRealSdkServer([{ body: completionBody('The lookup failed.') }]);

    await makeLLM('gpt-test').call({
      jsonMode: false,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather for a city.',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      history: [
        { role: 'user', content: 'Weather in Oslo?' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Oslo' } }],
        },
        {
          role: 'tool',
          toolResults: [{ toolCallId: 'call_1', content: 'service down', isError: true }],
        },
      ],
      userContent: 'What happened?',
    });

    const sentBody = at(server.requests, 0).body as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMessage = sentBody.messages.find((m) => m.role === 'tool');

    expect(toolMessage).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: expect.stringMatching(/^Error: .*service down/),
    });
  });

  it('surfaces a real OpenAI SDK error (429) through VernLLM retry handling', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        body: {
          error: {
            message: 'Rate limited by mock server',
            type: 'rate_limit_error',
          },
        },
      },
      {
        body: {
          id: 'chatcmpl-3',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'ok after retry',
              },
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 3,
            total_tokens: 8,
          },
        },
      },
    ]);

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${server.url}/v1`,
      maxRetries: 0,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
      maxRetries: 1,
      baseDelayMs: 1,
    });

    const result = await llm.call({
      userContent: 'hi',
      jsonMode: false,
    });

    expect(result).toBe('ok after retry');
    expect(server.requests.length).toBe(2);
  });

  it('caps a real Retry-After header by maxRetryAfterMs, for the wait and the error alike', async () => {
    const rateLimited = {
      status: 429,
      headers: { 'retry-after': '60' },
      body: { error: { message: 'slow down', type: 'rate_limit_error' } },
    };
    server = await startRealSdkServer([rateLimited, rateLimited]);
    const events: Array<{ kind: string; delayMs?: number; retryAfterHonored?: boolean }> = [];

    const llm = new VernLLM({
      client: fromOpenAICompatible(
        new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1`, maxRetries: 0 }),
      ),
      model: 'gpt-test',
      maxRetries: 1,
      maxRetryAfterMs: 0,
      logger: 'silent',
      onEvent: (event) => events.push(event),
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 0,
    });
    expect(server.requests).toHaveLength(2);
    expect(events.find((event) => event.kind === 'retry')).toMatchObject({
      delayMs: 0,
      retryAfterHonored: true,
    });
  });

  it('passes real multimodal image content through to the OpenAI SDK as a data URL', async () => {
    server = await startRealSdkServer([
      {
        body: {
          id: 'chatcmpl-4',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'I see a small red square.',
              },
            },
          ],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 8,
            total_tokens: 48,
          },
        },
      },
    ]);

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${server.url}/v1`,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
    });

    const result = await llm.call({
      userContent: [
        {
          type: 'text',
          text: "What's in this image?",
        },
        {
          type: 'image',
          data: 'ZmFrZWJhc2U2NA==',
          mimeType: 'image/png',
        },
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
            {
              type: 'text',
              text: "What's in this image?",
            },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,ZmFrZWJhc2U2NA==',
              },
            },
          ],
        },
      ],
    });
  });

  it('streams live text-delta chunks from a real OpenAI SSE response and resolves finalResult', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            data: {
              id: '1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: 'Hello, ',
                  },
                },
              ],
            },
          },
          {
            data: {
              id: '1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    content: 'world!',
                  },
                },
              ],
            },
          },
          {
            data: {
              id: '1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            },
          },
          { data: '[DONE]' },
        ]),
      },
    ]);

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${server.url}/v1`,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      {
        type: 'text-delta',
        delta: 'Hello, ',
      },
      {
        type: 'text-delta',
        delta: 'world!',
      },
      {
        type: 'usage',
        usage: expect.objectContaining({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        }),
      },
    ]);

    await expect(finalResult).resolves.toBe('Hello, world!');

    const sent = at(server.requests, 0);

    expect(sent.body).toMatchObject({
      stream: true,
      stream_options: {
        include_usage: true,
      },
    });
  });

  it.each([
    [
      'OpenAI cached_tokens',
      { prompt_tokens_details: { cached_tokens: 80 } },
      { cacheReadTokens: 80 },
    ],
    [
      "OpenRouter's cache_write_tokens",
      { prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 } },
      { cacheReadTokens: 60, cacheWriteTokens: 30 },
    ],
    [
      "DeepSeek's prompt_cache_hit_tokens",
      { prompt_cache_hit_tokens: 70 },
      { cacheReadTokens: 70 },
    ],
  ])(
    'reports %s on TokenUsage through a real OpenAI SDK client',
    async (_label, extra, expected) => {
      server = await startRealSdkServer([
        {
          body: {
            id: 'chatcmpl-c',
            object: 'chat.completion',
            created: 1234567890,
            model: 'gpt-test',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...extra },
          },
        },
      ]);
      const onUsage = vi.fn();
      const llm = new VernLLM({
        client: fromOpenAICompatible(
          new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` }),
        ),
        model: 'gpt-test',
        onUsage,
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          ...expected,
        }),
      );
    },
  );

  it('reports streamed cache counts on TokenUsage, filling cached_tokens from DeepSeek', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            data: {
              id: '1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
            },
          },
          {
            data: {
              id: '1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 5,
                total_tokens: 105,
                prompt_cache_hit_tokens: 70,
                prompt_tokens_details: { cache_write_tokens: 10 },
              },
            },
          },
          { data: '[DONE]' },
        ]),
      },
    ]);
    const onUsage = vi.fn();
    const llm = new VernLLM({
      client: fromOpenAICompatible(new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` })),
      model: 'gpt-test',
      onUsage,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    await drain(chunks);
    await finalResult;

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 100, cacheReadTokens: 70, cacheWriteTokens: 10 }),
    );
  });

  it('honors an aborted signal against a real OpenAI SDK client mid-request', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${server.url}/v1`,
      maxRetries: 0,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
      maxRetries: 0,
    });

    const controller = new AbortController();

    const callPromise = llm.call({
      userContent: 'hi',
      jsonMode: false,
      signal: controller.signal,
    });

    await vi.waitUntil(() => (server?.requests.length ?? 0) > 0);
    controller.abort();

    await expect(callPromise).rejects.toMatchObject({
      name: 'LLMError',
      type: 'aborted',
    });
  });

  it('reports a timeout against a real OpenAI SDK client that never responds', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${server.url}/v1`,
      maxRetries: 0,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
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

  it('reports a timeout against a real Groq SDK client that never responds', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const groq = new Groq({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });

    const llm = new VernLLM({
      client: fromGroq(groq),
      model: 'llama-test',
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
