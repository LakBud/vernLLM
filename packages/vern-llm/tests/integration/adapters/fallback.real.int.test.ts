import Anthropic from '@anthropic-ai/sdk';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';

import { fromAnthropic } from '../../../src/adapters/anthropic.js';
import { type BedrockConverseClient, fromBedrock } from '../../../src/adapters/bedrock.js';
import { fromGemini, type GeminiClient } from '../../../src/adapters/gemini.js';
import { fromOpenAICompatible } from '../../../src/adapters/openaiCompatible.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { drain } from '../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../realSdkServer.js';

/** Same bridging cast the Gemini real-SDK adapter tests use; see `gemini.real.int.test.ts`. */
function asGeminiClient(models: GoogleGenAI['models']): GeminiClient {
  return models as unknown as GeminiClient;
}

/** Same `.send(command)` -> `.converse()` bridge the Bedrock real-SDK adapter tests use. */
function wrapBedrockClient(client: BedrockRuntimeClient): BedrockConverseClient {
  return {
    converse: async (params, options) => {
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

/**
 * Exercises `VernLLMOptions.fallback` end to end against *real* SDK client
 * instances for every provider adapter VernLLM ships, each pointed at its
 * own local mock server instead of a real API. Unlike `fallback.unit.test.ts`
 * (hand-rolled `LLMClient` mocks proving the fallback *mechanism*), this
 * proves the mechanism actually composes with each real adapter's own
 * request serialization and response/error parsing, one provider target at
 * a time, exactly as a caller mixing real providers in `fallback` would.
 */
describe('VernLLM fallback, real SDK clients across providers', () => {
  const servers: RealSdkServer[] = [];

  afterEach(async () => {
    // Snapshot and clear before awaiting: if a close() rejects, the array is
    // already reset and `allSettled` (rather than `all`) means the rest of
    // the servers still get their close() called instead of one failure
    // aborting cleanup for the others.
    const toClose = servers.splice(0, servers.length);
    await Promise.allSettled(toClose.map((s) => s.close()));
  });

  async function mockServer(...responses: Parameters<typeof startRealSdkServer>[0]) {
    const server = await startRealSdkServer(responses);
    servers.push(server);
    return server;
  }

  it(
    'falls over OpenAI -> Anthropic -> Gemini -> Bedrock, each a real SDK client, and ' +
      'answers from whichever target actually succeeds',
    async () => {
      // Primary: real OpenAI SDK client, fails.
      const openaiServer = await mockServer({
        status: 500,
        body: { error: { message: 'openai down', type: 'server_error' } },
      });
      const openai = new OpenAI({
        apiKey: 'test-key',
        baseURL: `${openaiServer.url}/v1`,
        maxRetries: 0,
      });

      // Fallback 1: real Anthropic SDK client, fails.
      const anthropicServer = await mockServer({
        status: 500,
        body: { type: 'error', error: { type: 'api_error', message: 'anthropic down' } },
      });
      const anthropic = new Anthropic({
        apiKey: 'test-key',
        baseURL: anthropicServer.url,
        maxRetries: 0,
      });

      // Fallback 2: real Google GenAI SDK client, fails.
      const geminiServer = await mockServer({
        status: 500,
        body: { error: { code: 500, message: 'gemini down', status: 'INTERNAL' } },
      });
      const gemini = new GoogleGenAI({
        apiKey: 'test-key',
        httpOptions: { baseUrl: geminiServer.url },
      });

      // Fallback 3: real Bedrock SDK client, succeeds.
      const bedrockServer = await mockServer({
        body: {
          output: {
            message: { role: 'assistant', content: [{ text: 'answer from Bedrock' }] },
          },
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        },
      });
      const bedrock = new BedrockRuntimeClient({
        region: 'us-east-1',
        endpoint: bedrockServer.url,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        requestHandler: new NodeHttpHandler(),
        maxAttempts: 1,
      });

      const meta: { current?: import('../../../src/types/index.js').CallMeta } = {};

      const llm = new VernLLM({
        client: fromOpenAICompatible(openai),
        model: 'gpt-test',
        name: 'openai',
        maxRetries: 0,
        fallback: [
          { client: fromAnthropic(anthropic), model: 'claude-test', name: 'anthropic' },
          {
            client: fromGemini(asGeminiClient(gemini.models)),
            model: 'gemini-test',
            name: 'gemini',
          },
          {
            client: fromBedrock(wrapBedrockClient(bedrock)),
            model: 'anthropic.claude-test',
            name: 'bedrock',
          },
        ],
      });

      const result = await llm.call({ userContent: "What's the answer?", jsonMode: false, meta });

      expect(result).toBe('answer from Bedrock');

      // Every earlier target was actually tried, exactly once each, real
      // wire round-trip and all, before the chain reached Bedrock.
      expect(openaiServer.requests).toHaveLength(1);
      expect(anthropicServer.requests).toHaveLength(1);
      expect(geminiServer.requests).toHaveLength(1);
      expect(bedrockServer.requests).toHaveLength(1);

      expect(meta.current).toMatchObject({
        provider: 'bedrock',
        model: 'anthropic.claude-test',
        fallbackIndex: 2,
        usedFallback: true,
      });
    },
  );

  it('a real Anthropic SDK client as the sole primary answers directly, no fallback declared', async () => {
    const server = await mockServer({
      body: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'Paris is the capital of France.' }],
        usage: { input_tokens: 10, output_tokens: 6 },
      },
    });

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({ client: fromAnthropic(anthropic), model: 'claude-test' });

    const result = await llm.call({
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris is the capital of France.');
    expect(server.requests).toHaveLength(1);
  });

  it('a real OpenAI SDK client that succeeds skips a real Anthropic SDK client declared as fallback', async () => {
    const openaiServer = await mockServer({
      body: {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok from primary' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    });
    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${openaiServer.url}/v1` });

    const anthropicServer = await mockServer({
      body: {
        id: 'msg_never',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'should never be reached' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: anthropicServer.url });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
      fallback: { client: fromAnthropic(anthropic), model: 'claude-test' },
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('ok from primary');
    expect(openaiServer.requests).toHaveLength(1);
    expect(anthropicServer.requests).toHaveLength(0);
  });

  it('a real OpenAI SDK stream-open failure falls over to a real Anthropic SDK stream', async () => {
    const openaiServer = await mockServer({
      status: 500,
      body: { error: { message: 'openai stream down', type: 'server_error' } },
    });
    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${openaiServer.url}/v1`,
      maxRetries: 0,
    });

    const anthropicServer = await mockServer({
      raw: sseRaw([
        {
          event: 'message_start',
          data: { type: 'message_start', message: { usage: { input_tokens: 8 } } },
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
            delta: { type: 'text_delta', text: 'streamed from Anthropic' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 4 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    });
    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: anthropicServer.url });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
      maxRetries: 0,
      fallback: { client: fromAnthropic(anthropic), model: 'claude-test' },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(
      collected.some((c) => c.type === 'text-delta' && c.delta === 'streamed from Anthropic'),
    ).toBe(true);
    await expect(finalResult).resolves.toBe('streamed from Anthropic');
    expect(openaiServer.requests).toHaveLength(1);
    expect(anthropicServer.requests).toHaveLength(1);
  });

  it('FallbackExhaustedError.attempts carries every real provider error, in order, when all four fail', async () => {
    const openaiServer = await mockServer({
      status: 500,
      body: { error: { message: 'openai down', type: 'server_error' } },
    });
    const openai = new OpenAI({
      apiKey: 'test-key',
      baseURL: `${openaiServer.url}/v1`,
      maxRetries: 0,
    });

    const anthropicServer = await mockServer({
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'anthropic down' } },
    });
    const anthropic = new Anthropic({
      apiKey: 'test-key',
      baseURL: anthropicServer.url,
      maxRetries: 0,
    });

    const geminiServer = await mockServer({
      status: 500,
      body: { error: { code: 500, message: 'gemini down', status: 'INTERNAL' } },
    });
    const gemini = new GoogleGenAI({
      apiKey: 'test-key',
      httpOptions: { baseUrl: geminiServer.url },
    });

    const bedrockServer = await mockServer({
      status: 500,
      headers: { 'x-amzn-errortype': 'InternalServerException' },
      body: { message: 'bedrock down' },
    });
    const bedrock = new BedrockRuntimeClient({
      region: 'us-east-1',
      endpoint: bedrockServer.url,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: new NodeHttpHandler(),
      maxAttempts: 1,
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(openai),
      model: 'gpt-test',
      name: 'openai',
      maxRetries: 0,
      fallback: [
        { client: fromAnthropic(anthropic), model: 'claude-test', name: 'anthropic' },
        {
          client: fromGemini(asGeminiClient(gemini.models)),
          model: 'gemini-test',
          name: 'gemini',
        },
        {
          client: fromBedrock(wrapBedrockClient(bedrock)),
          model: 'anthropic.claude-test',
          name: 'bedrock',
        },
      ],
    });

    let caught: unknown;
    try {
      await llm.call({ userContent: 'hi', jsonMode: false });
    } catch (error) {
      caught = error;
    }

    const { FallbackExhaustedError } = await import('../../../src/types/index.js');
    expect(caught).toBeInstanceOf(FallbackExhaustedError);

    const exhausted = caught as InstanceType<typeof FallbackExhaustedError>;
    expect(exhausted.attempts.map((a) => a.provider)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'bedrock',
    ]);
    expect(exhausted.attempts.every((a) => a.error.type === 'api')).toBe(true);
  });
});
