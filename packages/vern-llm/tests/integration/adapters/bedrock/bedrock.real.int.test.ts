import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterEach, describe, expect, it } from 'vitest';

import { fromBedrock, type BedrockConverseClient } from '../../../../src/adapters/bedrock.js';
import { type StreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at } from '../../../helpers.js';
import {
  bedrockEventStreamRaw,
  startRealSdkServer,
  type RealSdkServer,
} from '../../../realSdkServer.js';

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

/**
 * Wraps a real `BedrockRuntimeClient` the way `bedrock.ts`'s own doc comment
 * says to: the AWS SDK v3 client exposes `.send(command)`, not a direct
 * `.converse()` method, so this bridges the two. `NodeHttpHandler` is
 * forced because the SDK's default handler negotiates HTTP/2 for AWS
 * endpoints, which the plain `node:http` mock server below can't speak;
 * `maxAttempts: 1` disables the AWS SDK's own internal retries so
 * VernLLM's retry logic (under test) is the only thing retrying.
 */
function wrapBedrockClient(client: BedrockRuntimeClient): BedrockConverseClient {
  return {
    converse: async (params, options) => {
      // Same rationale as the Anthropic/Gemini real-SDK tests: the real
      // AWS SDK's generated `ConverseCommandInput`/`ConverseCommandOutput`
      // types are stricter than this adapter's own hand-written
      // `BedrockConverseClient` structural type (e.g. its content-block
      // union carries an internal `$unknown` discriminant member this
      // adapter's type doesn't know about), so both sides are cast through
      // `unknown` rather than trying to make the two type declarations
      // structurally identical.
      const response = await client.send(
        new ConverseCommand(params as unknown as ConstructorParameters<typeof ConverseCommand>[0]),
        { abortSignal: options.signal },
      );

      return response as unknown as Awaited<ReturnType<BedrockConverseClient['converse']>>;
    },
    converseStream: async (params, options) => {
      const response = await client.send(
        new ConverseStreamCommand(
          params as unknown as ConstructorParameters<typeof ConverseStreamCommand>[0],
        ),
        { abortSignal: options.signal },
      );

      return response as unknown as Awaited<
        ReturnType<NonNullable<BedrockConverseClient['converseStream']>>
      >;
    },
  };
}

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
      client: fromBedrock(wrapBedrockClient(makeClient())),
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

    const client = fromBedrock(wrapBedrockClient(makeClient()));

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
    expect(result.usage).toEqual({ prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });

    const sent = at(server.requests, 0);
    expect(sent.body).toMatchObject({
      toolConfig: {
        tools: [
          expect.objectContaining({ toolSpec: expect.objectContaining({ name: 'Summary' }) }),
        ],
        toolChoice: { tool: { name: 'Summary' } },
      },
    });
  });

  it('surfaces a real Bedrock SDK error (429/ThrottlingException) to the caller with the correct status', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        body: { message: 'Rate limited by mock server' },
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(wrapBedrockClient(makeClient())),
      model: 'anthropic.claude-test',
      maxRetries: 0,
    });

    // A real Bedrock 429 (ThrottlingException) exposes its HTTP status only
    // as `error.$metadata.httpStatusCode`, not `error.status` or
    // `error.statusCode`. `extractStatus` (src/internal/vernLLM.utils.ts)
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
            message: { role: 'assistant', content: [{ text: 'I see a small red square.' }] },
          },
          usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        },
      },
    ]);

    const llm = new VernLLM({
      client: fromBedrock(wrapBedrockClient(makeClient())),
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
      messages: Array<{ content: Array<{ text?: string; image?: { format: string } }> }>;
    };
    const imageBlock = sentBody.messages[0]?.content[1];
    expect(imageBlock?.image?.format).toBe('png');
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
      client: fromBedrock(wrapBedrockClient(makeClient())),
      model: 'anthropic.claude-test',
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

  it('honors an aborted signal against a real Bedrock SDK client mid-request', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const llm = new VernLLM({
      client: fromBedrock(wrapBedrockClient(makeClient())),
      model: 'anthropic.claude-test',
      maxRetries: 0,
    });

    const controller = new AbortController();
    const callPromise = llm.call({ userContent: 'hi', jsonMode: false, signal: controller.signal });

    queueMicrotask(() => controller.abort());

    await expect(callPromise).rejects.toMatchObject({ name: 'LLMError', type: 'aborted' });
  });
});
