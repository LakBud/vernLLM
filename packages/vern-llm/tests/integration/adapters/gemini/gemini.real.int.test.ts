import { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../../src/adapters/gemini.js';
import { type StreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

/**
 * `GeminiClient` now matches the real `@google/genai` SDK's `ai.models`
 * shape directly (single-argument `generateContent`/`generateContentStream`,
 * `config`-nested fields, `config.abortSignal`), so no bridging wrapper is
 * needed, just `fromGemini(ai.models)`. A cast is still needed to satisfy
 * TS: the real SDK's generated types are stricter than this adapter's own
 * hand-written structural type in a few spots (e.g. `functionCall.args` is
 * `Record<string, unknown> | undefined` there vs `unknown` here, `mode` is
 * a real enum not a string union), same rationale as the adapter's own
 * internal `as unknown as` casts elsewhere: the wire contract is what's
 * actually relied on, not either side's exact TS types.
 */
function asGeminiClient(models: GoogleGenAI['models']): GeminiClient {
  return models as unknown as GeminiClient;
}

describe('Gemini adapter integration (real @google/genai client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('drives a real Google GenAI client through VernLLM.call end to end', async () => {
    server = await startRealSdkServer([
      {
        body: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Paris is the capital of France.' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 9, totalTokenCount: 31 },
        },
      },
    ]);

    const ai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } });

    const llm = new VernLLM({
      client: fromGemini(asGeminiClient(ai.models)),
      model: 'gemini-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are a helpful geography assistant.',
      userContent: "What's the capital of France?",
      jsonMode: false,
    });

    expect(result).toBe('Paris is the capital of France.');

    const sent = at(server.requests, 0);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1beta/models/gemini-test:generateContent');
    expect(sent.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: "What's the capital of France?" }] }],
      systemInstruction: { parts: [{ text: 'You are a helpful geography assistant.' }] },
    });
  });

  it('sends real functionCall/tool round-trip through the real SDK client', async () => {
    server = await startRealSdkServer([
      {
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'getWeather', args: { city: 'Paris' } } }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 10, totalTokenCount: 25 },
        },
      },
    ]);

    const ai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } });
    const client = fromGemini(asGeminiClient(ai.models));

    const result = await client.chat.completions.create(
      {
        model: 'gemini-test',
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
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        messages: [{ role: 'user', content: "What's the weather in Paris?" }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'getWeather',
        type: 'function',
        function: { name: 'getWeather', arguments: '{"city":"Paris"}' },
      },
    ]);

    const sent = at(server.requests, 0);
    expect(sent.body).toMatchObject({
      tools: [
        expect.objectContaining({
          functionDeclarations: [expect.objectContaining({ name: 'getWeather' })],
        }),
      ],
    });
  });

  it('surfaces a real Google GenAI SDK error (429) through VernLLM retry handling', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        body: {
          error: {
            code: 429,
            message: 'Rate limited by mock server',
            status: 'RESOURCE_EXHAUSTED',
          },
        },
      },
      {
        body: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok after retry' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        },
      },
    ]);

    const ai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } });

    const llm = new VernLLM({
      client: fromGemini(asGeminiClient(ai.models)),
      model: 'gemini-test',
      maxRetries: 1,
      baseDelayMs: 1,
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('ok after retry');
    expect(server.requests.length).toBe(2);
  });

  it('streams live text-delta chunks from a real Gemini SSE response and resolves finalResult', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([
          {
            data: {
              candidates: [{ content: { role: 'model', parts: [{ text: 'Hello, ' }] } }],
            },
          },
          {
            data: {
              candidates: [{ content: { role: 'model', parts: [{ text: 'world!' }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            },
          },
        ]),
      },
    ]);

    const ai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } });

    const llm = new VernLLM({
      client: fromGemini(asGeminiClient(ai.models)),
      model: 'gemini-test',
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

  it('honors an aborted signal against a real Google GenAI SDK client mid-request', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const ai = new GoogleGenAI({
      apiKey: 'test-key',
      httpOptions: { baseUrl: server.url },
    });

    const llm = new VernLLM({
      client: fromGemini(asGeminiClient(ai.models)),
      model: 'gemini-test',
      maxRetries: 0,
    });

    const controller = new AbortController();

    const callPromise = llm.call({
      userContent: 'hi',
      jsonMode: false,
      signal: controller.signal,
    });

    // Wait until the real SDK has actually reached the mock server before
    // aborting, so this exercises cancellation of an in-flight request.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (server!.requests.length > 0) {
          resolve();
        } else {
          setTimeout(check, 0);
        }
      };

      check();
    });

    controller.abort();

    await expect(callPromise).rejects.toMatchObject({
      name: 'LLMError',
      type: 'aborted',
    });
  });
});
