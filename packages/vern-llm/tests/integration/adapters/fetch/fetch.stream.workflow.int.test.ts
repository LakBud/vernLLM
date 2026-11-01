import { describe, expect, it, vi, afterEach } from 'vitest';

import { fromFetch, type StreamRequestLike } from '../../../../src/adapters/index.js';
import {
  type CallMeta,
  type StreamChunk,
  type WireStreamChunk,
} from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { fakeReadableStream } from '../../../helpers.js';

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

interface FakeSseEvent {
  delta?: string;
  toolCall?: { index: number; id?: string; name?: string; argsDelta?: string };
  usage?: { prompt: number; completion: number; total: number };
  refusal?: boolean;
  finish?: string;
}

function mapEvent(event: unknown): WireStreamChunk | undefined {
  const e = event as FakeSseEvent;

  if (e.delta) return { type: 'text-delta', delta: e.delta };
  if (e.toolCall) {
    return {
      type: 'tool_call_delta',
      index: e.toolCall.index,
      id: e.toolCall.id,
      name: e.toolCall.name,
      argumentsDelta: e.toolCall.argsDelta,
    };
  }
  if (e.refusal) return { type: 'refusal' };
  if (e.finish) return { type: 'finish', reason: e.finish };
  if (e.usage) {
    return {
      type: 'usage',
      usage: {
        prompt_tokens: e.usage.prompt,
        completion_tokens: e.usage.completion,
        total_tokens: e.usage.total,
      },
    };
  }
  return undefined;
}

describe('VernLLM.call(stream: true) through fromFetch, end to end', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams live text-delta chunks (default SSE framing over native fetch) and resolves finalResult to the same parsed/validated shape a non-streaming call would return', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      body: fakeReadableStream([
        'data: {"delta":"{\\"city\\":"}\n\n',
        'data: {"delta":"\\"Denver\\"}"}\n\n',
        'data: {"usage":{"prompt":10,"completion":5,"total":15}}\n\n',
      ]),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const llm = new VernLLM({
      client: fromFetch({
        url: 'https://api.example.com/stream',
        mapRequest: (params) => ({ model: params.model }),
        mapResponse: () => {
          throw new Error('non-streaming mapResponse should not be reached for stream: true');
        },
        mapStreamEvent: mapEvent,
      }),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call<{ city: string }>({
      userContent: 'where?',
      jsonMode: true,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: '{"city":' },
      { type: 'text-delta', delta: '"Denver"}' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
      },
    ]);

    await expect(finalResult).resolves.toEqual({ city: 'Denver' });
  });

  it('streams tool_call_delta events that accumulate into the same validated ToolCall[] a non-streaming call would return', async () => {
    const requestStream = vi.fn(async (_url: string, _init: unknown) =>
      fakeReadableStream([
        'data: {"toolCall":{"index":0,"id":"call_1","name":"get_weather","argsDelta":"{\\"city\\":"}}\n\n',
        'data: {"toolCall":{"index":0,"argsDelta":"\\"Denver\\"}"}}\n\n',
      ]),
    );

    const llm = new VernLLM({
      client: fromFetch({
        url: 'https://api.example.com',
        requestStream,
        mapRequest: () => ({}),
        mapResponse: () => {
          throw new Error('non-streaming mapResponse should not be reached for stream: true');
        },
        mapStreamEvent: mapEvent,
      }),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'weather in Denver?',
      tools: [
        {
          name: 'get_weather',
          description: 'Gets the current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argsDelta: '{"city":',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        id: undefined,
        name: undefined,
        argsDelta: '"Denver"}',
      },
    ]);

    await expect(finalResult).resolves.toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
  });

  it('rejects finalResult with a normalized LLMError when mapStreamEvent is not configured, matching the other adapters', async () => {
    const llm = new VernLLM({
      client: fromFetch({
        url: 'https://api.example.com',
        mapRequest: () => ({}),
        mapResponse: (json: unknown) => ({ content: String(json) }),
        // mapStreamEvent intentionally omitted
      }),
      model: 'test-model',
    });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ type: 'invalid_params' });
  });

  describe('provider refusals', () => {
    const refusingLlm = (
      requestStream: StreamRequestLike | undefined,
      fetchCalls: { count: number },
    ) =>
      new VernLLM({
        client: fromFetch({
          url: 'https://api.example.com',
          requestStream,
          mapRequest: () => ({}),
          mapResponse: () => {
            fetchCalls.count += 1;
            return { refusal: 'declined', usage: { promptTokens: 4, totalTokens: 4 } };
          },
          mapStreamEvent: mapEvent,
        }),
        model: 'test-model',
        maxRetries: 2,
        baseDelayMs: 1,
      });

    it('fails a streamed refusal once as model_refused, with the usage chunk still reported', async () => {
      const requestStream = vi.fn<StreamRequestLike>(async () =>
        fakeReadableStream([
          'data: {"refusal":true}\n\n',
          'data: {"usage":{"prompt":4,"completion":0,"total":4}}\n\n',
        ]),
      );
      const calls = { count: 0 };
      const llm = refusingLlm(requestStream, calls);

      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
      });

      await expect(drain(chunks)).rejects.toMatchObject({
        type: 'invalid_params',
        code: 'model_refused',
      });
      await expect(finalResult).rejects.toMatchObject({ code: 'model_refused' });
      expect(requestStream).toHaveBeenCalledTimes(1);
    });

    it('fails a non streaming refusal once as model_refused, with no retry', async () => {
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      }));
      vi.stubGlobal('fetch', fetchMock);
      const calls = { count: 0 };
      const llm = refusingLlm(undefined, calls);

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
        type: 'invalid_params',
        code: 'model_refused',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calls.count).toBe(1);
    });

    it('returns the content when mapResponse carries both content and a refusal', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({}),
        })),
      );
      const llm = new VernLLM({
        client: fromFetch({
          url: 'https://api.example.com',
          mapRequest: () => ({}),
          mapResponse: () => ({ content: 'Partial answer.', refusal: 'declined' }),
        }),
        model: 'test-model',
      });

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).resolves.toBe(
        'Partial answer.',
      );
    });
  });

  describe('finish reason', () => {
    const nonStreaming = (mapped: { finishReason?: string; content?: string }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({}),
        })),
      );

      return new VernLLM({
        client: fromFetch({
          url: 'https://api.example.com',
          mapRequest: () => ({}),
          mapResponse: () => ({ content: 'An answer.', ...mapped }),
        }),
        model: 'test-model',
      });
    };

    it.each([
      ['stop', 'stop'],
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['guardrail', 'guardrail'],
      ['function_call', 'tool_calls'],
      ['made_up', 'other'],
    ])('reports mapResponse finishReason %s as %s', async (finishReason, expected) => {
      const llm = nonStreaming({ finishReason });
      const meta: { current?: CallMeta } = {};

      await llm.call({ userContent: 'hi', jsonMode: false, meta });

      expect(meta.current?.finishReason).toBe(expected);
    });

    it('leaves finishReason unset when the mapper reports none', async () => {
      const llm = nonStreaming({});
      const meta: { current?: CallMeta } = {};

      await llm.call({ userContent: 'hi', jsonMode: false, meta });

      expect(meta.current).toBeDefined();
      expect(meta.current).not.toHaveProperty('finishReason');
    });

    it('reports a refusal that came with content as refusal, not stop', async () => {
      const llm = nonStreaming({ finishReason: 'stop', refusal: 'declined' } as never);
      const meta: { current?: CallMeta } = {};

      await llm.call({ userContent: 'hi', jsonMode: false, meta });

      expect(meta.current?.finishReason).toBe('refusal');
    });

    it('sets finishReason on a stream once finalResult resolves', async () => {
      const requestStream = vi.fn(async (_url: string, _init: unknown) =>
        fakeReadableStream([
          'data: {"delta":"Half an "}\n\n',
          'data: {"delta":"answer"}\n\n',
          'data: {"finish":"content_filter"}\n\n',
        ]),
      );
      const llm = new VernLLM({
        client: fromFetch({
          url: 'https://api.example.com',
          requestStream,
          mapRequest: () => ({}),
          mapResponse: () => ({}),
          mapStreamEvent: mapEvent,
        }),
        model: 'test-model',
      });
      const meta: { current?: CallMeta } = {};

      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
        meta,
      });
      await drain(chunks);

      await expect(finalResult).resolves.toBe('Half an answer');
      expect(meta.current?.finishReason).toBe('content_filter');
    });

    it.each([
      ['length', 'response_truncated'],
      ['stop', undefined],
    ])(
      'fails a streamed JSON answer that cannot be parsed after finish %s with code %s',
      async (finish, code) => {
        const requestStream = vi.fn(async (_url: string, _init: unknown) =>
          fakeReadableStream([
            'data: {"delta":"{\\"city\\":"}\n\n',
            `data: {"finish":"${finish}"}\n\n`,
          ]),
        );
        const llm = new VernLLM({
          client: fromFetch({
            url: 'https://api.example.com',
            requestStream,
            mapRequest: () => ({}),
            mapResponse: () => ({}),
            mapStreamEvent: mapEvent,
          }),
          model: 'test-model',
          maxRetries: 0,
        });

        const { chunks, finalResult } = await llm.call({
          userContent: 'hi',
          jsonMode: true,
          stream: true,
        });
        await drain(chunks);

        await expect(finalResult).rejects.toMatchObject({ type: 'parse', code });
      },
    );

    it("does not carry a failed target's finish reason into the fallback answer", async () => {
      const primary = fromFetch({
        url: 'https://api.example.com/a',
        mapRequest: () => ({}),
        mapResponse: () => ({ content: '', finishReason: 'content_filter' }),
        request: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => '',
          json: async () => ({}),
        }),
      });
      const fallback = fromFetch({
        url: 'https://api.example.com/b',
        mapRequest: () => ({}),
        mapResponse: () => ({ content: 'From fallback.' }),
        request: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => '',
          json: async () => ({}),
        }),
      });
      const llm = new VernLLM({
        client: primary,
        model: 'a',
        maxRetries: 0,
        fallback: { client: fallback, model: 'b' },
      });
      const meta: { current?: CallMeta } = {};

      await expect(llm.call({ userContent: 'hi', jsonMode: false, meta })).resolves.toBe(
        'From fallback.',
      );
      expect(meta.current?.usedFallback).toBe(true);
      expect(meta.current).not.toHaveProperty('finishReason');
    });
  });
});
