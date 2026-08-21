import { describe, it, expect, vi } from 'vitest';

import {
  type AnthropicClient,
  fromAnthropic,
  type BedrockConverseClient,
  fromBedrock,
  fromGemini,
  type GeminiClient,
  fromOpenAICompatible,
} from '../../../src/adapters/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function fakeAsyncIterable(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= events.length) return { done: true, value: undefined };
          const value = events[index];
          index++;
          return { done: false, value };
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe('fromAnthropic().chat.completions.createStream reasoning budget', () => {
  function makeFakeStreamingAnthropicClient(events: unknown[]) {
    const create = vi.fn(async (_params: unknown, _options: unknown) => fakeAsyncIterable(events));
    return { client: { messages: { create } } as unknown as AnthropicClient, create };
  }

  it('sends budget_tokens directly onto thinking.budget_tokens on a legacy model', async () => {
    const { client, create } = makeFakeStreamingAnthropicClient([{ type: 'message_stop' }]);
    const adapted = fromAnthropic(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(create.mock.calls[0]![0]).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
  });

  it('converts reasoning_effort to a token budget on a legacy model', async () => {
    const { client, create } = makeFakeStreamingAnthropicClient([{ type: 'message_stop' }]);
    const adapted = fromAnthropic(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
          max_tokens: 100000,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(create.mock.calls[0]![0]).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });
  });

  it('prefers budget_tokens over reasoning_effort when both are set', async () => {
    const { client, create } = makeFakeStreamingAnthropicClient([{ type: 'message_stop' }]);
    const adapted = fromAnthropic(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
          max_tokens: 100000,
          budget_tokens: 5000,
          reasoning_effort: 'minimal',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(create.mock.calls[0]![0]).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 5000 },
    });
  });

  it('sends adaptive thinking plus output_config.effort on an adaptive-only model', async () => {
    const { client, create } = makeFakeStreamingAnthropicClient([{ type: 'message_stop' }]);
    const adapted = fromAnthropic(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-sonnet-5',
          max_tokens: 100000,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(create.mock.calls[0]![0]).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
  });

  it('omits temperature on the stream path whenever thinking is present', async () => {
    const { client, create } = makeFakeStreamingAnthropicClient([{ type: 'message_stop' }]);
    const adapted = fromAnthropic(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
          max_tokens: 100000,
          temperature: 0.2,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect('temperature' in (create.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);
  });

  it('normalizes output_tokens_details.thinking_tokens from message_delta into a usage chunk', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'message_delta',
        usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } },
      },
      { type: 'message_stop' },
    ]);
    const adapted = fromAnthropic(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    const usageChunk = chunks.find((c) => c.type === 'usage');
    expect(usageChunk).toMatchObject({
      usage: { completion_tokens_details: { reasoning_tokens: 30 } },
    });
  });
});

describe('fromGemini().chat.completions.createStream reasoning budget', () => {
  function makeFakeStreamingGeminiClient(chunks: unknown[]) {
    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({}));
    const generateContentStream = vi.fn((_params: unknown) =>
      Promise.resolve(fakeAsyncIterable(chunks)),
    );

    return {
      client: { generateContent, generateContentStream } as unknown as GeminiClient,
      generateContentStream,
    };
  }

  it('sends budget_tokens directly onto config.thinkingConfig.thinkingBudget', async () => {
    const { client, generateContentStream } = makeFakeStreamingGeminiClient([{}]);
    const adapted = fromGemini(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'gemini-3.1-flash-lite',
          max_tokens: 200,
          budget_tokens: 12000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(generateContentStream.mock.calls[0]![0]).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: 12000 } },
    });
  });

  it('converts reasoning_effort to a token budget when budget_tokens is unset', async () => {
    const { client, generateContentStream } = makeFakeStreamingGeminiClient([{}]);
    const adapted = fromGemini(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'gemini-3.1-flash-lite',
          max_tokens: 200,
          reasoning_effort: 'low',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(generateContentStream.mock.calls[0]![0]).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: 4096 } },
    });
  });

  it('prefers budget_tokens over reasoning_effort when both are set', async () => {
    const { client, generateContentStream } = makeFakeStreamingGeminiClient([{}]);
    const adapted = fromGemini(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'gemini-3.1-flash-lite',
          max_tokens: 200,
          budget_tokens: 500,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(generateContentStream.mock.calls[0]![0]).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: 500 } },
    });
  });

  it('normalizes usageMetadata.thoughtsTokenCount from the last chunk into a usage chunk', async () => {
    const { client } = makeFakeStreamingGeminiClient([
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 20,
          totalTokenCount: 24,
          thoughtsTokenCount: 15,
        },
      },
    ]);
    const adapted = fromGemini(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'gemini-3.1-flash-lite',
          max_tokens: 200,
          budget_tokens: 12000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    const usageChunk = chunks.find((c) => c.type === 'usage');
    expect(usageChunk).toMatchObject({
      usage: { completion_tokens_details: { reasoning_tokens: 15 } },
    });
  });
});

describe('fromOpenAICompatible().chat.completions.createStream reasoning budget', () => {
  function makeFakeStreamingOpenAIClient(chunks: unknown[]) {
    const create = vi.fn(async (_params: unknown, _options: unknown) => fakeAsyncIterable(chunks));
    return { client: { chat: { completions: { create } } }, create };
  }

  it('forwards reasoning_effort unchanged and leaves budget_tokens off the wire', async () => {
    const { client, create } = makeFakeStreamingOpenAIClient([{ choices: [{ delta: {} }] }]);
    const adapted = fromOpenAICompatible(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'm',
          max_tokens: 10,
          reasoning_effort: 'medium',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.reasoning_effort).toBe('medium');
    expect('budget_tokens' in sent).toBe(false);
  });

  it('converts budget_tokens to the nearest reasoning_effort tier when reasoning_effort is unset', async () => {
    const { client, create } = makeFakeStreamingOpenAIClient([{ choices: [{ delta: {} }] }]);
    const adapted = fromOpenAICompatible(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'm',
          max_tokens: 10,
          budget_tokens: 20000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.reasoning_effort).toBe('high');
    expect('budget_tokens' in sent).toBe(false);
  });

  it('prefers reasoning_effort over budget_tokens when both are set', async () => {
    const { client, create } = makeFakeStreamingOpenAIClient([{ choices: [{ delta: {} }] }]);
    const adapted = fromOpenAICompatible(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'm',
          max_tokens: 10,
          reasoning_effort: 'low',
          budget_tokens: 32000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.reasoning_effort).toBe('low');
    expect('budget_tokens' in sent).toBe(false);
  });

  it('normalizes completion_tokens_details.reasoning_tokens from the usage chunk', async () => {
    const { client } = makeFakeStreamingOpenAIClient([
      { choices: [{ delta: { content: 'hi' } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 50,
          total_tokens: 60,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      },
    ]);
    const adapted = fromOpenAICompatible(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'm',
          max_tokens: 10,
          reasoning_effort: 'medium',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    const usageChunk = chunks.find((c) => c.type === 'usage');
    expect(usageChunk).toMatchObject({
      usage: { completion_tokens_details: { reasoning_tokens: 30 } },
    });
  });
});

describe('fromBedrock().chat.completions.createStream reasoning budget', () => {
  function makeFakeStreamingBedrockClient(events: unknown[]) {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));
    const converseStream = vi.fn(async (_params: unknown, _options: unknown) => ({
      stream: fakeAsyncIterable(events),
    }));

    return {
      client: { converse, converseStream } as unknown as BedrockConverseClient,
      converseStream,
    };
  }

  it('forwards budget_tokens as additionalModelRequestFields for a Claude model', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100000,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(converseStream.mock.calls[0]![0]).toMatchObject({
      additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 9000 } },
    });
  });

  it('sends adaptive thinking plus outputConfig.effort on an adaptive-only Claude model', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-sonnet-5-20260101-v1:0',
          max_tokens: 100000,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(converseStream.mock.calls[0]![0]).toMatchObject({
      additionalModelRequestFields: { thinking: { type: 'adaptive' } },
      outputConfig: { effort: 'high' },
    });
  });

  it('omits temperature on the stream path whenever thinking is present for a Claude model', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100000,
          temperature: 0.2,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(
      'temperature' in
        ((converseStream.mock.calls[0]![0] as { inferenceConfig?: Record<string, unknown> })
          .inferenceConfig ?? {}),
    ).toBe(false);
  });

  it('drops budget_tokens for a non-Claude model on the stream path too', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'amazon.titan-text-premier-v1:0',
          max_tokens: 100000,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(
      'additionalModelRequestFields' in
        (converseStream.mock.calls[0]![0] as Record<string, unknown>),
    ).toBe(false);
  });
});
