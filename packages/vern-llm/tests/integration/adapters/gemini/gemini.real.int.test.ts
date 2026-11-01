import { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromGemini } from '../../../../src/adapters/gemini/index.js';
import { resetSdkRetryWarnings } from '../../../../src/adapters/internal/sdkRetries.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, drain } from '../../../helpers.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * `GeminiClient` matches the real `@google/genai` SDK's types precisely
 * enough that `fromGemini(ai)` type-checks against the real `GoogleGenAI`
 * instance below with no cast anywhere in this file.
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
    expect(sent.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: "What's the capital of France?" }] }],
      systemInstruction: { parts: [{ text: 'You are a helpful geography assistant.' }] },
    });
  });

  it('reports cachedContentTokenCount as cacheReadTokens, inside promptTokens', async () => {
    server = await startRealSdkServer([
      {
        body: {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'cached' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 80,
            candidatesTokenCount: 6,
            totalTokenCount: 106,
          },
        },
      },
    ]);
    const onUsage = vi.fn();
    const ai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } });
    const llm = new VernLLM({ client: fromGemini(ai), model: 'gemini-test', onUsage });

    await llm.call({ userContent: 'hi', jsonMode: false });

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 100,
        completionTokens: 6,
        totalTokens: 106,
        cacheReadTokens: 80,
      }),
    );
    expect(onUsage.mock.calls[0]?.[0]).not.toHaveProperty('cacheWriteTokens');
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
    const client = fromGemini(ai);

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
        id: 'getWeather#0',
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
      client: fromGemini(ai),
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
      client: fromGemini(ai),
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
      client: fromGemini(ai),
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

  it('type-checks with no cast against the real GoogleGenAI client, and rejects ai.models', () => {
    // The first half is checked at compile time: `pnpm typecheck:test`
    // fails if `fromGemini(ai)` needs a cast.
    const ai = new GoogleGenAI({ apiKey: 'test-key' });

    expect(typeof fromGemini(ai).chat.completions.create).toBe('function');
    // @ts-expect-error ai.models is not a GeminiClient
    expect(() => fromGemini(ai.models)).toThrow('fromGemini takes the top level client: pass ai');
  });

  it('reports a timeout against a real Google GenAI SDK client that never responds', async () => {
    server = await startRealSdkServer([{ hang: true }]);

    const ai = new GoogleGenAI({
      apiKey: 'test-key',
      httpOptions: { baseUrl: server.url },
    });

    const llm = new VernLLM({
      client: fromGemini(ai),
      model: 'gemini-test',
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

  it('names the provider from a real top level client, Gemini API or Vertex AI', () => {
    expect(fromGemini(new GoogleGenAI({ apiKey: 'test-key' })).adapter).toEqual({
      name: 'gemini',
      provider: 'gcp.gemini',
    });
    expect(
      fromGemini(new GoogleGenAI({ vertexai: true, project: 'p', location: 'us-central1' }))
        .adapter,
    ).toEqual({ name: 'gemini', provider: 'gcp.vertex_ai' });
  });

  describe('provider refusals', () => {
    const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 0, totalTokenCount: 12 };
    const answer = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'from fallback' }] } }],
      usageMetadata,
    };
    const blockedPrompt = { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata };
    const finishedWith = (finishReason: string, text?: string) => ({
      candidates: [
        {
          content: { role: 'model', parts: text ? [{ text }] : [] },
          finishReason,
        },
      ],
      usageMetadata,
    });

    /** A primary that answers with `response`, and a fallback that must not be asked. */
    async function withFallback(response: Parameters<typeof startRealSdkServer>[0][number]) {
      server = await startRealSdkServer([response]);
      const fallbackServer = await startRealSdkServer([{ body: answer }]);

      const llm = new VernLLM({
        client: fromGemini(
          new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } }),
        ),
        model: 'gemini-test',
        maxRetries: 3,
        baseDelayMs: 0,
        fallback: {
          client: fromGemini(
            new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: fallbackServer.url } }),
          ),
          model: 'gemini-fallback',
        },
      });

      return { llm, fallbackServer };
    }

    async function single(response: Parameters<typeof startRealSdkServer>[0][number]) {
      server = await startRealSdkServer([response]);

      return new VernLLM({
        client: fromGemini(
          new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: server.url } }),
        ),
        model: 'gemini-test',
        maxRetries: 0,
      });
    }

    it.each([
      ['a SAFETY finish with no content', finishedWith('SAFETY')],
      ['a BLOCKLIST finish with no content', finishedWith('BLOCKLIST')],
      ['a PROHIBITED_CONTENT finish with no content', finishedWith('PROHIBITED_CONTENT')],
      ['a SPII finish with no content', finishedWith('SPII')],
      ['a blocked prompt, which has no candidates', blockedPrompt],
      ['a prompt blocked as OTHER', { promptFeedback: { blockReason: 'OTHER' }, usageMetadata }],
    ])('fails once as model_refused on %s', async (_name, body) => {
      const { llm, fallbackServer } = await withFallback({ body });

      try {
        await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
          type: 'invalid_params',
          code: 'model_refused',
        });
        expect(server?.requests).toHaveLength(1);
        expect(fallbackServer.requests).toHaveLength(0);
      } finally {
        await fallbackServer.close();
      }
    });

    it('fails once as model_refused on a stream that ends in a refusal with no content', async () => {
      const { llm, fallbackServer } = await withFallback({
        raw: sseRaw([{ data: finishedWith('SAFETY') }]),
      });

      try {
        const { chunks, finalResult } = await llm.call({
          userContent: 'hi',
          jsonMode: false,
          stream: true,
        });

        await expect(drain(chunks)).rejects.toMatchObject({ code: 'model_refused' });
        await expect(finalResult).rejects.toMatchObject({ code: 'model_refused' });
        expect(server?.requests).toHaveLength(1);
        expect(fallbackServer.requests).toHaveLength(0);
      } finally {
        await fallbackServer.close();
      }
    });

    it('fails once as model_refused on a stream whose prompt was blocked', async () => {
      const { llm, fallbackServer } = await withFallback({
        raw: sseRaw([{ data: blockedPrompt }]),
      });

      try {
        const { chunks } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

        await expect(drain(chunks)).rejects.toMatchObject({ code: 'model_refused' });
        expect(server?.requests).toHaveLength(1);
        expect(fallbackServer.requests).toHaveLength(0);
      } finally {
        await fallbackServer.close();
      }
    });

    it('returns a partial answer that ends in a SAFETY finish', async () => {
      const llm = await single({ body: finishedWith('SAFETY', 'Partial answer.') });

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).resolves.toBe(
        'Partial answer.',
      );
    });

    it('returns streamed text that ends in a SAFETY finish', async () => {
      const llm = await single({
        raw: sseRaw([{ data: finishedWith('SAFETY', 'Partial answer.') }]),
      });

      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
      });
      await drain(chunks);

      await expect(finalResult).resolves.toBe('Partial answer.');
    });

    it.each([
      ['RECITATION', finishedWith('RECITATION')],
      ['LANGUAGE', finishedWith('LANGUAGE')],
      ['OTHER', finishedWith('OTHER')],
      [
        'an unspecified block reason',
        { promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' }, usageMetadata },
      ],
    ])('keeps failing as empty_response for %s with no content', async (_name, body) => {
      const llm = await single({ body });

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
        code: 'empty_response',
      });
    });
  });
});

describe('Gemini adapter, SDK retry warning (real @google/genai client)', () => {
  beforeEach(() => resetSdkRetryWarnings());

  function spyLogger() {
    return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it('stays silent for a default client, which does not retry', () => {
    const logger = spyLogger();

    new VernLLM({ client: fromGemini(new GoogleGenAI({ apiKey: 'k' })), model: 'm', logger });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when retryOptions is set, counting the SDK's default of 5 attempts", () => {
    const logger = spyLogger();
    const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { retryOptions: {} } });

    new VernLLM({ client: fromGemini(ai), model: 'm', logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[VernLLM\] gemini: the SDK client retries up to 4 times on its own.*Remove httpOptions\.retryOptions/,
      ),
    );
  });

  it('counts attempts the way the SDK does when untyped config passes a string', () => {
    const logger = spyLogger();
    // Plain JS or config read from env can hand the SDK a string, which it coerces.
    const retryOptions = { attempts: '3' } as unknown as { attempts: number };
    const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { retryOptions } });

    new VernLLM({ client: fromGemini(ai), model: 'm', logger });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retries up to 2 times'));
  });

  it('stays silent when attempts is not a number the SDK can read', () => {
    const logger = spyLogger();
    const retryOptions = { attempts: 'many' } as unknown as { attempts: number };
    const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { retryOptions } });

    new VernLLM({ client: fromGemini(ai), model: 'm', logger });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent when retryOptions allows a single attempt', () => {
    const logger = spyLogger();
    const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { retryOptions: { attempts: 1 } } });

    new VernLLM({ client: fromGemini(ai), model: 'm', logger });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
