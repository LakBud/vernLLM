import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromGroq, fromOpenAICompatible } from '../../../../src/adapters/openaiCompatible.js';
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
});
