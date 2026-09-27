import { describe, expect, it, vi } from 'vitest';

import {
  fromAnthropic,
  fromBedrock,
  fromOpenAICompatible,
  type AnthropicClient,
  type BedrockConverseClient,
} from '../../../../src/adapters/index.js';

import type { LLMClient, WireStreamChunk } from '../../../../src/types/index.js';

type Request = Parameters<LLMClient['chat']['completions']['create']>[0];

const signal = new AbortController().signal;

function iterable(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

async function collect(stream: AsyncIterable<WireStreamChunk>): Promise<WireStreamChunk[]> {
  const out: WireStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** A tool loop continuation: the assistant turn carries its reasoning ahead of the tool call. */
const continuation: Request = {
  model: 'claude-test',
  max_tokens: 2000,
  messages: [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
      ],
      thinking: [
        { type: 'thinking', thinking: 'need the tool', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'AAEC' },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
  ],
};

describe('fromAnthropic, thinking blocks', () => {
  function anthropicClient(result: unknown) {
    const create = vi.fn(async () => result);
    return { client: { messages: { create } } as unknown as AnthropicClient, create };
  }

  it('sends reasoning ahead of the text and tool_use blocks of the assistant turn', async () => {
    const { client, create } = anthropicClient({ content: [{ type: 'text', text: 'ok' }] });

    await fromAnthropic(client).chat.completions.create(continuation, { signal });

    const body = (create.mock.calls[0] as unknown as [{ messages: unknown[] }])[0];
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'need the tool', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'AAEC' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
      ],
    });
  });

  it('sends reasoning on an assistant turn without tool calls', async () => {
    const { client, create } = anthropicClient({ content: [{ type: 'text', text: 'ok' }] });

    await fromAnthropic(client).chat.completions.create(
      {
        model: 'claude-test',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'hello',
            thinking: [{ type: 'thinking', thinking: 't', signature: 's' }],
          },
          { role: 'user', content: 'again' },
        ],
      },
      { signal },
    );

    const body = (create.mock.calls[0] as unknown as [{ messages: unknown[] }])[0];
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 't', signature: 's' },
        { type: 'text', text: 'hello' },
      ],
    });
  });

  it('reports the reasoning blocks of a response, in order', async () => {
    const { client } = anthropicClient({
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'redacted_thinking', data: 'enc' },
        { type: 'thinking' },
        { type: 'redacted_thinking' },
        { type: 'tool_use', id: 't1', name: 'get_weather', input: {} },
      ],
    });

    const response = await fromAnthropic(client).chat.completions.create(
      { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { signal },
    );

    expect(response.choices?.[0]?.message?.thinking).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'redacted_thinking', data: 'enc' },
      { type: 'thinking', thinking: '', signature: '' },
      { type: 'redacted_thinking', data: '' },
    ]);
  });

  it('leaves thinking off a response that has none', async () => {
    const { client } = anthropicClient({ content: [{ type: 'text', text: 'ok' }] });

    const response = await fromAnthropic(client).chat.completions.create(
      { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { signal },
    );

    expect(response.choices?.[0]?.message).not.toHaveProperty('thinking');
  });

  it('assembles streamed reasoning and yields each block when it stops', async () => {
    const create = vi.fn(async () =>
      iterable([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'redacted_thinking', data: 'enc' },
        },
        // A stray delta on a redacted block carries nothing to append.
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'x' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'signature_delta', signature: 'x' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'thinking' } },
        { type: 'content_block_stop', index: 3 },
        { type: 'content_block_start', index: 4, content_block: { type: 'text' } },
        // An unknown delta type is ignored rather than misrouted.
        { type: 'content_block_delta', index: 4, delta: { type: 'citations_delta' } },
        { type: 'content_block_stop', index: 4 },
        { type: 'message_stop' },
      ]),
    );
    const client = { messages: { create } } as unknown as AnthropicClient;

    const chunks = await collect(
      fromAnthropic(client).chat.completions.createStream!(
        { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        { signal },
      ),
    );

    expect(chunks.filter((chunk) => chunk.type === 'thinking_block')).toEqual([
      { type: 'thinking_block', block: { type: 'thinking', thinking: 'ab', signature: 'sig' } },
      { type: 'thinking_block', block: { type: 'redacted_thinking', data: 'enc' } },
      { type: 'thinking_block', block: { type: 'redacted_thinking', data: '' } },
      { type: 'thinking_block', block: { type: 'thinking', thinking: '', signature: '' } },
    ]);
    // One ping per reasoning delta, before the block stops, so the idle
    // timeout sees activity while reasoning is still being accumulated.
    const firstBlock = chunks.findIndex((chunk) => chunk.type === 'thinking_block');
    expect(chunks.slice(0, firstBlock).filter((chunk) => chunk.type === 'ping')).toHaveLength(3);
    expect(chunks.filter((chunk) => chunk.type === 'ping')).toHaveLength(5);
  });
});

describe('fromBedrock, thinking blocks', () => {
  it('sends reasoning as reasoningContent ahead of the text and toolUse blocks', async () => {
    const converse = vi.fn(async () => ({ output: { message: { content: [{ text: 'ok' }] } } }));
    const client = { converse } as unknown as BedrockConverseClient;

    await fromBedrock(client).chat.completions.create(
      { ...continuation, model: 'anthropic.claude-test' },
      { signal },
    );

    const request = (converse.mock.calls[0] as unknown as [{ messages: unknown[] }])[0];
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { reasoningContent: { reasoningText: { text: 'need the tool', signature: 'sig-1' } } },
        { reasoningContent: { redactedContent: new Uint8Array([0, 1, 2]) } },
        { text: 'Checking.' },
        { toolUse: { toolUseId: 'call_1', name: 'get_weather', input: {} } },
      ],
    });
  });

  it('sends reasoning on an assistant turn without tool calls', async () => {
    const converse = vi.fn(async () => ({ output: { message: { content: [{ text: 'ok' }] } } }));
    const client = { converse } as unknown as BedrockConverseClient;

    await fromBedrock(client).chat.completions.create(
      {
        model: 'anthropic.claude-test',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'hello',
            thinking: [{ type: 'thinking', thinking: 't', signature: 's' }],
          },
          { role: 'user', content: 'again' },
        ],
      },
      { signal },
    );

    const request = (converse.mock.calls[0] as unknown as [{ messages: unknown[] }])[0];
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { reasoningContent: { reasoningText: { text: 't', signature: 's' } } },
        { text: 'hello' },
      ],
    });
  });

  it('reports reasoning blocks from a Converse response, redacted bytes as base64', async () => {
    const converse = vi.fn(async () => ({
      output: {
        message: {
          content: [
            { reasoningContent: { reasoningText: { text: 'plan', signature: 'sig' } } },
            { reasoningContent: { redactedContent: new Uint8Array([0, 1, 2]) } },
            { reasoningContent: {} },
            { text: 'ok' },
          ],
        },
      },
    }));
    const client = { converse } as unknown as BedrockConverseClient;

    const response = await fromBedrock(client).chat.completions.create(
      {
        model: 'anthropic.claude-test',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal },
    );

    expect(response.choices?.[0]?.message?.thinking).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'redacted_thinking', data: 'AAEC' },
      { type: 'thinking', thinking: '', signature: '' },
    ]);
  });

  it('assembles streamed reasoning deltas and yields each block when it stops', async () => {
    const converseStream = vi.fn(async () => ({
      stream: iterable([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'a' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'b' } } } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: 'sig' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { reasoningContent: { redactedContent: new Uint8Array([0, 1, 2]) } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { contentBlockDelta: { contentBlockIndex: 2, delta: { text: 'done' } } },
        { contentBlockStop: { contentBlockIndex: 2 } },
      ]),
    }));
    const client = {
      converse: vi.fn(),
      converseStream,
    } as unknown as BedrockConverseClient;

    const chunks = await collect(
      fromBedrock(client).chat.completions.createStream!(
        {
          model: 'anthropic.claude-test',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal },
      ),
    );

    expect(chunks.filter((chunk) => chunk.type === 'thinking_block')).toEqual([
      { type: 'thinking_block', block: { type: 'thinking', thinking: 'ab', signature: 'sig' } },
      { type: 'thinking_block', block: { type: 'redacted_thinking', data: 'AAEC' } },
    ]);
    expect(chunks).toContainEqual({ type: 'text-delta', delta: 'done' });
    // One ping per reasoning delta, before the block stops.
    const firstBlock = chunks.findIndex((chunk) => chunk.type === 'thinking_block');
    expect(chunks.slice(0, firstBlock).filter((chunk) => chunk.type === 'ping')).toHaveLength(3);
    expect(chunks.filter((chunk) => chunk.type === 'ping')).toHaveLength(4);
  });
});

describe('fromOpenAICompatible, thinking blocks', () => {
  it('drops reasoning from assistant turns, since OpenAI rejects unknown message fields', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'ok' } }] }));

    await fromOpenAICompatible({ chat: { completions: { create } } }).chat.completions.create(
      { ...continuation, model: 'gpt-4o' },
      { signal },
    );

    const sent = (
      create.mock.calls[0] as unknown as [{ messages: Array<Record<string, unknown>> }]
    )[0];
    expect(sent.messages[1]).not.toHaveProperty('thinking');
    expect(sent.messages[1]).toMatchObject({ role: 'assistant', content: 'Checking.' });
  });
});
