import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { VernLLM } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { resetBedrockRetryWarning } from '../../src/sdkRetries.js';
import { at, collect } from '../helpers.js';
import { bedrockEventStreamRaw, startRealSdkServer, type RealSdkServer } from '../realSdkServer.js';

/**
 * The missing `stream` check in `fromBedrock` is intentionally NOT exercised here against a
 * real `BedrockRuntimeClient`: the real SDK always synthesizes a decoder
 * stream object for any 200 response regardless of body shape. Verified
 * directly, a plain `{}` JSON body still produces a real
 * `SmithyMessageDecoderStream`), so a genuinely `undefined` `stream` isn't
 * reachable through any wire response this mock server can construct.
 * That's exactly why it's a defensive, type-level-only check: covered by
 * the fabricated-response unit test in
 * `tests/unit/bedrock.client.unit.test.ts` instead,
 * where the adapter boundary can be exercised directly.
 */
describe('Bedrock adapter integration (real @aws-sdk/client-bedrock-runtime client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function makeClient(): BedrockRuntimeClient {
    if (!server) throw new Error('server not started');
    return new BedrockRuntimeClient({
      region: 'us-east-1',
      endpoint: server.url,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: new NodeHttpHandler(),
      maxAttempts: 1,
    });
  }

  it('drives a real Bedrock Converse client through VernLLM.call end to end', async () => {
    server = await startRealSdkServer([
      {
        body: {
          output: {
            message: {
              role: 'assistant',
              content: [{ text: 'Paris is the capital of France.' }],
            },
          },
          stopReason: 'end_turn',
          usage: { inputTokens: 22, outputTokens: 9, totalTokens: 31 },
        },
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are a helpful geography assistant.',
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris is the capital of France.');

    const sent = at(server.requests, 0);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/model/anthropic.claude-test/converse');
    expect(sent.body).toMatchObject({
      messages: [{ role: 'user', content: [{ text: "What's the capital of France?" }] }],
      system: [{ text: 'You are a helpful geography assistant.' }],
    });
  });

  it('forces real tool-use for json_schema structured output and unwraps the real SDK response', async () => {
    server = await startRealSdkServer([
      {
        body: {
          output: {
            message: {
              role: 'assistant',
              content: [
                {
                  toolUse: {
                    toolUseId: 'tool_1',
                    name: 'Summary',
                    input: { headline: 'Real SDK works', score: 9 },
                  },
                },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
        },
      },
    ]);

    const client = fromBedrock(makeClient());

    const result = await client.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 200,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Summary',
            schema: {
              type: 'object',
              properties: {
                headline: { type: 'string' },
                score: { type: 'number' },
              },
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
      toolConfig: {
        tools: [
          expect.objectContaining({
            toolSpec: expect.objectContaining({ name: 'Summary' }),
          }),
        ],
        toolChoice: { tool: { name: 'Summary' } },
      },
    });
  });

  it(
    'sends jsonSchema as outputConfig.textFormat alongside real tools against a real Bedrock ' +
      'Converse client, on a model covered by nativeStructuredOutputModels',
    async () => {
      server = await startRealSdkServer([
        {
          body: {
            output: {
              message: {
                role: 'assistant',
                content: [{ text: '{"headline":"Native works","score":10}' }],
              },
            },
            stopReason: 'end_turn',
            usage: { inputTokens: 26, outputTokens: 11, totalTokens: 37 },
          },
        },
      ]);

      const client = fromBedrock(makeClient(), {
        nativeStructuredOutputModels: ['anthropic.claude-native-test'],
      });

      const result = await client.chat.completions.create(
        {
          model: 'anthropic.claude-native-test',
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

      // Real Converse client, real wire body: outputConfig.textFormat
      // nests the schema under structure.jsonSchema, JSON-encoded as a
      // string (not the parsed object toolConfig's tool schemas use), and
      // has no strict field, matching the real Bedrock API exactly. Real
      // `tools` are sent unmodified in the normal toolConfig field,
      // alongside outputConfig, not instead of it.
      const sent = at(server.requests, 0);
      expect(sent.body).toMatchObject({
        outputConfig: {
          textFormat: {
            type: 'json_schema',
            structure: {
              jsonSchema: {
                schema: JSON.stringify({
                  type: 'object',
                  properties: { headline: { type: 'string' }, score: { type: 'number' } },
                  required: ['headline', 'score'],
                }),
                name: 'Summary',
              },
            },
          },
        },
        toolConfig: {
          tools: [
            expect.objectContaining({
              toolSpec: expect.objectContaining({ name: 'get_context' }),
            }),
          ],
        },
      });
    },
  );

  it('sends strictly alternating roles for a tool loop continued with a new user message', async () => {
    server = await startRealSdkServer([
      {
        body: {
          output: { message: { role: 'assistant', content: [{ text: 'It is 70F in New York.' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        },
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are a weather assistant.',
      jsonMode: false,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather for a city.',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      history: [
        { role: 'user', content: 'Weather in New York?' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'New York' } }],
        },
        { role: 'tool', toolResults: [{ toolCallId: 'call_1', content: { tempC: 21 } }] },
      ],
      userContent: 'Answer in Fahrenheit.',
    });

    expect(result).toMatchObject({ content: 'It is 70F in New York.' });

    const sentBody = at(server.requests, 0).body as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };

    // The audited bug sent user, assistant, user, user here, which Converse rejects.
    expect(sentBody.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sentBody.messages.at(-1)?.content).toEqual([
      {
        toolResult: expect.objectContaining({ toolUseId: 'call_1', status: 'success' }),
      },
      { text: 'Answer in Fahrenheit.' },
    ]);
  });

  it('surfaces a real Bedrock SDK error (429/ThrottlingException) to the caller with the correct status', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        headers: {
          'x-amzn-errortype': 'ThrottlingException',
        },
        body: { message: 'Rate limited by mock server' },
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
      maxRetries: 0,
    });

    // A real Bedrock 429 (ThrottlingException) exposes its HTTP status only
    // as `error.$metadata.httpStatusCode`, not `error.status` or
    // `error.statusCode`. `extractStatus` (src/internal/execution/errors.utils.ts)
    // checks all three, so this classifies as a status-429 "api" error,
    // letting status-based retry/non-retry decisions (`nonRetryableStatus`)
    // act on it the same as any other provider's error.
    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      name: 'LLMError',
      type: 'api',
      status: 429,
    });
  });

  it('passes real multimodal image content through to the Bedrock SDK as raw bytes', async () => {
    server = await startRealSdkServer([
      {
        body: {
          output: {
            message: {
              role: 'assistant',
              content: [{ text: 'I see a small red square.' }],
            },
          },
          usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        },
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
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
    const sentBody = sent.body as {
      messages: Array<{
        content: Array<{
          text?: string;
          image?: {
            format: string;
            source?: {
              bytes?: string | number[] | Record<string, number>;
            };
          };
        }>;
      }>;
    };

    const imageBlock = sentBody.messages[0]?.content[1];

    expect(imageBlock?.image?.format).toBe('png');

    const imageBytes = imageBlock?.image?.source?.bytes;
    expect(imageBytes).toBeDefined();

    const originalBytes = Uint8Array.from(Buffer.from('ZmFrZWJhc2U2NA==', 'base64'));

    const receivedBytes =
      typeof imageBytes === 'string'
        ? Uint8Array.from(Buffer.from(imageBytes, 'base64'))
        : Array.isArray(imageBytes)
          ? Uint8Array.from(imageBytes)
          : Uint8Array.from(Object.values(imageBytes ?? {}));

    expect(receivedBytes).toEqual(originalBytes);
  });

  it('streams live text-delta chunks from a real Bedrock binary event-stream response and resolves finalResult', async () => {
    server = await startRealSdkServer([
      {
        raw: await bedrockEventStreamRaw([
          { eventType: 'messageStart', payload: { role: 'assistant' } },
          {
            eventType: 'contentBlockDelta',
            payload: { contentBlockIndex: 0, delta: { text: 'Hello, ' } },
          },
          {
            eventType: 'contentBlockDelta',
            payload: { contentBlockIndex: 0, delta: { text: 'world!' } },
          },
          { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
          { eventType: 'messageStop', payload: { stopReason: 'end_turn' } },
          {
            eventType: 'metadata',
            payload: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          },
        ]),
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await collect(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
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
  });

  it('folds real cache counts into promptTokens so prompt plus completion matches the reported total', async () => {
    server = await startRealSdkServer([
      {
        body: {
          output: { message: { role: 'assistant', content: [{ text: 'cached' }] } },
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 10015,
            cacheReadInputTokens: 8000,
            cacheWriteInputTokens: 2000,
            cacheDetails: [
              { ttl: '5m', inputTokens: 1500 },
              { ttl: '1h', inputTokens: 500 },
            ],
          },
        },
      },
    ]);
    const onUsage = vi.fn();
    const release = vi.fn();
    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
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
    // Bedrock's total always included cache tokens, and its limiter counts them, so nothing is left out.
    expect(release).toHaveBeenCalledWith(10015, true);
  });

  it('folds streamed cache counts from a real Bedrock event stream into promptTokens', async () => {
    server = await startRealSdkServer([
      {
        raw: await bedrockEventStreamRaw([
          { eventType: 'messageStart', payload: { role: 'assistant' } },
          {
            eventType: 'contentBlockDelta',
            payload: { contentBlockIndex: 0, delta: { text: 'cached' } },
          },
          { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
          { eventType: 'messageStop', payload: { stopReason: 'end_turn' } },
          {
            eventType: 'metadata',
            payload: {
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 10015,
                cacheReadInputTokens: 8000,
                cacheWriteInputTokens: 2000,
                cacheDetails: [{ ttl: '1h', inputTokens: 2000 }],
              },
            },
          },
        ]),
      },
    ]);
    const onUsage = vi.fn();
    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
      onUsage,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    await collect(chunks);
    await finalResult;

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 10010,
        completionTokens: 5,
        totalTokens: 10015,
        cacheReadTokens: 8000,
        cacheWriteTokens: 2000,
        cacheWriteTokensByTtl: { '1h': 2000 },
      }),
    );
  });

  it('honors an aborted signal against a real Bedrock SDK client mid-request', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
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

  it('answers as a fallback target, and names itself to middleware on AttemptContext.adapter', async () => {
    server = await startRealSdkServer([
      {
        body: {
          output: {
            message: { role: 'assistant', content: [{ text: 'Paris.' }] },
          },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        },
      },
    ]);

    const failingPrimary = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error('primary down'), { status: 500 });
          },
        },
      },
    };
    const adapters: unknown[] = [];

    const llm = new VernLLM({
      client: failingPrimary,
      model: 'primary-model',
      maxRetries: 0,
      logger: 'silent',
      fallback: { client: fromBedrock(makeClient()), model: 'anthropic.claude-test' },
      middleware: [
        {
          name: 'adapter-probe',
          dispatch: async (_request, next, ctx) => {
            adapters.push(ctx.adapter);
            await next();
          },
        },
      ],
    });

    const result = await llm.call({
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris.');
    expect(adapters).toEqual([{ name: 'custom' }, { name: 'bedrock', provider: 'aws.bedrock' }]);
    expect(at(server.requests, 0).url).toBe('/model/anthropic.claude-test/converse');
  });

  it('drops a real, wire-marshalled unrecognized ($unknown) stream event instead of misrouting or crashing on it', async () => {
    // Exercises the ConverseStreamOutput union gap against the real SDK's
    // own event-stream unmarshaller: 'someFutureEventType' isn't a member
    // any version of the SDK models, so the real BedrockRuntimeClient
    // itself resolves it to a genuine `{ $unknown: [...] }` event, the
    // same shape a real newer-than-this-SDK event from AWS would produce.
    server = await startRealSdkServer([
      {
        raw: await bedrockEventStreamRaw([
          { eventType: 'messageStart', payload: { role: 'assistant' } },
          { eventType: 'someFutureEventType', payload: { anything: 'here' } },
          {
            eventType: 'contentBlockDelta',
            payload: { contentBlockIndex: 0, delta: { text: 'hi' } },
          },
          { eventType: 'messageStop', payload: { stopReason: 'end_turn' } },
          {
            eventType: 'metadata',
            payload: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          },
        ]),
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await collect(chunks);

    // Only the recognized events produced chunks; the real, wire-decoded
    // $unknown event contributed nothing (and didn't crash the stream).
    expect(collected).toEqual([
      { type: 'text-delta', delta: 'hi' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      },
    ]);

    await expect(finalResult).resolves.toBe('hi');
  });

  it('reports a timeout against a real Bedrock SDK client that never responds', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'anthropic.claude-test',
      maxRetries: 0,
      timeoutMs: 100,
    });

    // Guards that the SDK's own abort error still surfaces as a timeout
    // rather than 'unknown'.
    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      name: 'LLMError',
      type: 'timeout',
      code: 'request_timeout',
    });
  });
});

describe('Bedrock adapter integration, thinking and forced tool_choice (real AWS SDK client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function makeClient(): BedrockRuntimeClient {
    if (!server) throw new Error('server not started');
    return new BedrockRuntimeClient({
      region: 'us-east-1',
      endpoint: server.url,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: new NodeHttpHandler(),
      maxAttempts: 1,
    });
  }

  const weatherTool = {
    name: 'get_weather',
    description: 'Gets the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  };

  it('carries reasoningContent through a real tool loop, redacted bytes included', async () => {
    const redacted = Buffer.from([0, 1, 2]).toString('base64');
    server = await startRealSdkServer([
      {
        body: {
          output: {
            message: {
              role: 'assistant',
              content: [
                {
                  reasoningContent: {
                    reasoningText: { text: 'need weather', signature: 'sig-abc' },
                  },
                },
                { reasoningContent: { redactedContent: redacted } },
                { toolUse: { toolUseId: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } } },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      },
      {
        body: {
          output: { message: { role: 'assistant', content: [{ text: 'Sunny.' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      },
    ]);
    const llm = new VernLLM({ client: fromBedrock(makeClient()), model: 'anthropic.claude-test' });

    const first = await llm.call({
      userContent: 'Weather in Oslo?',
      tools: [weatherTool],
      budgetTokens: 2000,
      maxTokens: 4000,
    });
    if (first.type !== 'tool_calls') throw new Error('expected a tool call');

    expect(first.thinking).toEqual([
      { type: 'thinking', thinking: 'need weather', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: redacted },
    ]);

    await llm.call({
      userContent: 'Weather in Oslo?',
      tools: [weatherTool],
      budgetTokens: 2000,
      maxTokens: 4000,
      jsonMode: false,
      history: [
        { role: 'assistant', toolCalls: first.toolCalls, thinking: first.thinking },
        { role: 'tool', toolResults: [{ toolCallId: 'tu_1', content: 'sunny' }] },
      ],
    });

    const sent = at(server.requests, 1).body as {
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(sent.messages.find((m) => m.role === 'assistant')?.content).toEqual([
      { reasoningContent: { reasoningText: { text: 'need weather', signature: 'sig-abc' } } },
      { reasoningContent: { redactedContent: redacted } },
      { toolUse: { toolUseId: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } } },
    ]);
  });

  it('rejects a forced tool_choice on a region prefixed profile without sending anything', async () => {
    server = await startRealSdkServer([{ body: {} }]);
    const llm = new VernLLM({
      client: fromBedrock(makeClient()),
      model: 'us.anthropic.claude-opus-5-5-v1:0',
    });

    await expect(
      llm.call({ userContent: 'hi', tools: [weatherTool], toolChoice: 'required' }),
    ).rejects.toMatchObject({ type: 'invalid_params', code: 'unsupported_capability' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('Bedrock adapter, SDK retry warning (real BedrockRuntimeClient)', () => {
  function spyLogger() {
    return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  function client(maxAttempts?: BedrockRuntimeClientConfig['maxAttempts']) {
    return new BedrockRuntimeClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
  }

  // `AWS_MAX_ATTEMPTS` would change the SDK default under test.
  beforeEach(() => {
    vi.stubEnv('AWS_MAX_ATTEMPTS', undefined);
    resetBedrockRetryWarning();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("warns once the real client's default maxAttempts resolves", async () => {
    const logger = spyLogger();

    new VernLLM({ client: fromBedrock(client()), model: 'm', logger });

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[VernLLM\] bedrock: the SDK client retries up to 2 times on its own.*Pass maxAttempts: 1 to the BedrockRuntimeClient/,
      ),
    );
  });

  it('warns once per process, even for separate clients resolving at the same time', async () => {
    const first = spyLogger();
    const later = spyLogger();

    new VernLLM({
      client: fromBedrock(client()),
      model: 'a',
      fallback: { client: fromBedrock(client()), model: 'b' },
      logger: first,
    });
    new VernLLM({ client: fromBedrock(client()), model: 'm', logger: later });

    await vi.waitFor(() => expect(first.warn).toHaveBeenCalled());
    // Let the other providers settle, so a late second warning would show up here.
    await new Promise((resolve) => setImmediate(resolve));

    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(later.warn).not.toHaveBeenCalled();
  });

  it('stays silent with maxAttempts: 1, or a maxAttempts provider that rejects', async () => {
    const logger = spyLogger();
    const single = vi.fn(async () => 1);
    const rejecting = vi.fn(() => Promise.reject(new Error('config file unreadable')));

    new VernLLM({
      client: fromBedrock(client(single)),
      model: 'a',
      fallback: { client: fromBedrock(client(rejecting)), model: 'b' },
      logger,
    });

    await vi.waitFor(() => {
      expect(single).toHaveBeenCalled();
      expect(rejecting).toHaveBeenCalled();
    });
    // Let both provider promises settle before asserting nothing was logged.
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
