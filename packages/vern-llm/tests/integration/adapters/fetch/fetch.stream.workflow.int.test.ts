import { describe, expect, it, vi, afterEach } from 'vitest';

import { fromFetch } from '../../../../src/adapters/index.js';
import { type StreamChunk, type WireStreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';

/** A fake `ReadableStream<Uint8Array>`, as `response.body` would be. */
function fakeReadableStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(parts[index]));
      index++;
    },
  });
}

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

interface FakeSseEvent {
  delta?: string;
  toolCall?: { index: number; id?: string; name?: string; argsDelta?: string };
  usage?: { prompt: number; completion: number; total: number };
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

describe('VernLLM.call(stream: true) through fromFetch — end to end', () => {
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

    await drain(chunks);

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
    ).rejects.toMatchObject({ type: 'validation' });
  });
});
