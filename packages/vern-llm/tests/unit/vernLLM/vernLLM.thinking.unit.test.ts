import { describe, expect, it } from 'vitest';

import {
  VernLLM,
  isToolCallResult,
  type ConversationTurn,
  type ThinkingBlock,
  type WireStreamChunk,
} from '../../../src/index.js';
import { createMockClient, createMockStreamingClient, drain, textResponse } from '../../helpers.js';

const weatherTool = {
  name: 'get_weather',
  description: 'Gets the weather',
  parameters: { type: 'object', properties: {} },
};

const thinking: ThinkingBlock[] = [
  { type: 'thinking', thinking: 'need the tool', signature: 'sig' },
  { type: 'redacted_thinking', data: 'enc' },
];

const toolCall = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'get_weather', arguments: '{}' },
};

describe('VernLLM, thinking blocks in a tool loop', () => {
  it('returns the reasoning on a tool call result and sends it back on the next turn', async () => {
    const { client, calls } = createMockClient([
      { choices: [{ message: { content: '', tool_calls: [toolCall], thinking } }] },
      textResponse('sunny'),
    ]);
    const llm = new VernLLM({ client, model: 'claude' });

    const first = await llm.call({ userContent: 'weather?', tools: [weatherTool] });
    if (!isToolCallResult(first)) throw new Error('expected a tool call');
    expect(first.thinking).toEqual(thinking);

    const history: ConversationTurn[] = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', toolCalls: first.toolCalls, thinking: first.thinking },
      { role: 'tool', toolResults: [{ toolCallId: 'call_1', content: 'sunny' }] },
    ];
    await llm.call({ userContent: 'thanks', history, tools: [weatherTool] });

    expect(calls[1]!.messages[1]).toMatchObject({ role: 'assistant', thinking });
  });

  it('keeps reasoning off a plain content result', async () => {
    const { client } = createMockClient([{ choices: [{ message: { content: 'hi', thinking } }] }]);
    const llm = new VernLLM({ client, model: 'claude' });

    const result = await llm.call({ userContent: 'hi', tools: [weatherTool], jsonMode: false });

    expect(result).toEqual({ type: 'content', content: 'hi' });
  });

  it('leaves thinking off a tool call result when there is none', async () => {
    const { client } = createMockClient([
      { choices: [{ message: { content: '', tool_calls: [toolCall], thinking: [] } }] },
    ]);
    const llm = new VernLLM({ client, model: 'claude' });

    const result = await llm.call({ userContent: 'weather?', tools: [weatherTool] });

    expect(result).not.toHaveProperty('thinking');
  });

  it('sends reasoning on an assistant turn without tool calls', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'claude' });

    await llm.call({
      userContent: 'again',
      jsonMode: false,
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello', thinking },
      ],
    });

    expect(calls[0]!.messages[1]).toEqual({ role: 'assistant', content: 'hello', thinking });
  });

  it('collects streamed reasoning onto the tool call result, never as a chunk', async () => {
    const script: WireStreamChunk[] = [
      { type: 'thinking_block', block: thinking[0]! },
      { type: 'thinking_block', block: thinking[1]! },
      { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
    ];
    const { client } = createMockStreamingClient([script]);
    const llm = new VernLLM({ client, model: 'claude' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'weather?',
      tools: [weatherTool],
      stream: true,
    });
    const seen = await drain(chunks);

    expect(seen.map((chunk) => chunk.type)).not.toContain('thinking_block');
    await expect(finalResult).resolves.toMatchObject({ type: 'tool_calls', thinking });
  });

  it.each([
    ['not an array', 'nope'],
    ['a thinking block without a signature', [{ type: 'thinking', thinking: 't' }]],
    ['a redacted block without data', [{ type: 'redacted_thinking' }]],
    ['an unknown block type', [{ type: 'text', text: 't' }]],
    ['a null entry', [null]],
  ])('rejects history with %s locally', async (_label, bad) => {
    const { client, create } = createMockClient([textResponse('never')]);
    const llm = new VernLLM({ client, model: 'claude' });

    const error = await llm
      .call({
        userContent: 'again',
        jsonMode: false,
        history: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello', thinking: bad as ThinkingBlock[] },
        ],
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ type: 'invalid_params' });
    expect((error as Error).message).toContain('history[1].thinking');
    expect(create).not.toHaveBeenCalled();
  });
});
