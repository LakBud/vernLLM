import { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';

import { fromGemini } from '../../../../src/adapters/gemini.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, drain } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * `GeminiClient` now matches the real `@google/genai` SDK's types precisely
 * enough that no cast is needed at all: `fromGemini(ai.models)` and
 * `fromGemini(ai)` both type-check directly against the real `GoogleGenAI`
 * instance below, with no `as GeminiClient`/`as unknown as` anywhere in
 * this file. `GeminiClient` covers both shapes itself (an optional
 * self-referencing `models` field), so there's nothing else to import.
 * That's the specific thing this test file exists to prove, see the
 * `type-checks with no cast` test at the bottom.
 */
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
      client: fromGemini(ai.models),
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
    const client = fromGemini(ai.models);

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
      client: fromGemini(ai.models),
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
      client: fromGemini(ai.models),
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
      client: fromGemini(ai.models),
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

  it('drives a real Google GenAI client through VernLLM.call end to end when passed the whole client (fromGemini(ai))', async () => {
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

    // fromGemini(ai) here, NOT fromGemini(ai.models): the whole top-level
    // client, unwrapped internally. No `.models` and no cast at the call
    // site, which is the entire point of this test.
    const llm = new VernLLM({
      client: fromGemini(ai),
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
  });

  it('type-checks with no cast: fromGemini(ai.models) and fromGemini(ai) both accept the real GoogleGenAI client', () => {
    // This test's value is entirely at compile time. If either call below
    // needed `as GeminiClient` / `as unknown as GeminiClient` to satisfy
    // TypeScript, `pnpm typecheck:test` would fail, which is exactly the
    // signal this test exists to catch. There's nothing meaningful to
    // assert at runtime beyond "these functions exist and return an
    // LLMClient", so the assertions below are a formality; the compiler
    // doing the checking is the actual test.
    const ai = new GoogleGenAI({ apiKey: 'test-key' });

    const fromModels = fromGemini(ai.models);
    const fromTopLevel = fromGemini(ai);

    expect(typeof fromModels.chat.completions.create).toBe('function');
    expect(typeof fromTopLevel.chat.completions.create).toBe('function');
  });
});
