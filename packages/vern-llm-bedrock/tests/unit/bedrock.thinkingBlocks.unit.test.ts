import { describe, expect, it, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { stubbedClient } from '../helpers.js';

import type { LLMClient, WireStreamChunk } from 'vern-llm';

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

describe('fromBedrock, thinking blocks', () => {
  it('sends reasoning as reasoningContent ahead of the text and toolUse blocks', async () => {
    const converse = vi.fn(async () => ({ output: { message: { content: [{ text: 'ok' }] } } }));
    const client = stubbedClient({ converse });

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
    const client = stubbedClient({ converse });

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
    const client = stubbedClient({ converse });

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
    const client = stubbedClient({ converseStream });

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
