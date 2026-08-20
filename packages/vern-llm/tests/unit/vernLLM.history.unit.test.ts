import { describe, it, expect } from 'vitest';

import { LLMError } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { at, createMockClient, jsonResponse, textResponse } from '../helpers.js';

describe('VernLLM.call, conversation history', () => {
  it('sends only system + current user turn when no history is given', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', jsonMode: false });

    expect(at(calls, 0).messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('places prior turns between the system prompt and the current user turn, in order', async () => {
    const { client, calls } = createMockClient([textResponse('About 2.1 million.')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({
      systemPrompt: 'You are helpful.',
      userContent: "What's its population?",
      jsonMode: false,
      history: [
        { role: 'user', content: "What's the capital of France?" },
        { role: 'assistant', content: 'Paris.' },
      ],
    });

    expect(at(calls, 0).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: "What's the capital of France?" },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: "What's its population?" },
    ]);
  });

  it('treats an empty history array the same as omitting it', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', jsonMode: false, history: [] });

    expect(at(calls, 0).messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });
  it('accepts a parsed JsonValue as assistant history content and serializes it on the wire', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({
      userContent: 'continue',
      jsonMode: false,
      history: [
        { role: 'user', content: 'give me json' },
        { role: 'assistant', content: { name: 'Ada', skills: ['ts', 'js'] } },
      ],
    });

    expect(at(calls, 0).messages).toEqual([
      { role: 'user', content: 'give me json' },
      { role: 'assistant', content: JSON.stringify({ name: 'Ada', skills: ['ts', 'js'] }) },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('serializes non-object JsonValue assistant content (array, number, boolean, null) the same way', async () => {
    const { client, calls } = createMockClient([
      textResponse('ok'),
      textResponse('ok'),
      textResponse('ok'),
      textResponse('ok'),
    ]);
    const llm = new VernLLM({ client, model: 'm' });

    for (const value of [[1, 2, 3], 42, true, null]) {
      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: value },
        ],
      });
    }

    expect(at(calls, 0).messages[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify([1, 2, 3]),
    });
    expect(at(calls, 1).messages[1]).toEqual({ role: 'assistant', content: JSON.stringify(42) });
    expect(at(calls, 2).messages[1]).toEqual({ role: 'assistant', content: JSON.stringify(true) });
    expect(at(calls, 3).messages[1]).toEqual({ role: 'assistant', content: JSON.stringify(null) });
  });

  it('still sends a plain string assistant content unchanged', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({
      userContent: 'continue',
      jsonMode: false,
      history: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'Paris.' },
      ],
    });

    expect(at(calls, 0).messages[1]).toEqual({ role: 'assistant', content: 'Paris.' });
  });

  it('a jsonMode: true result can be pushed straight back into history and round-trips correctly', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ name: 'Ada', skills: ['ts'] }),
      textResponse('ok'),
    ]);
    const llm = new VernLLM({ client, model: 'm' });

    const parsed = await llm.call({ userContent: 'extract json', jsonMode: true });

    await llm.call({
      userContent: 'follow up',
      jsonMode: false,
      history: [
        { role: 'user', content: 'extract json' },
        { role: 'assistant', content: parsed },
      ],
    });

    expect(at(calls, 1).messages[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify({ name: 'Ada', skills: ['ts'] }),
    });
  });
});

describe('VernLLM.call, conversation history validation', () => {
  it('throws a non-retryable validation error when history ends with a user turn', async () => {
    const { client, create } = createMockClient([textResponse('unused')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    let err: LLMError | undefined;
    try {
      await llm.call({
        systemPrompt: 's',
        userContent: 'u',
        jsonMode: false,
        history: [{ role: 'user', content: 'first question' }],
      });
    } catch (e) {
      err = e as LLMError;
    }

    expect(err?.type).toBe('invalid_params');
    expect(err?.message).toMatch(/last entry in history/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws a non-retryable validation error on consecutive same-role turns', async () => {
    const { client, create } = createMockClient([textResponse('unused')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    let err: LLMError | undefined;
    try {
      await llm.call({
        systemPrompt: 's',
        userContent: 'u',
        jsonMode: false,
        history: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      });
    } catch (e) {
      err = e as LLMError;
    }

    expect(err?.type).toBe('invalid_params');
    expect(err?.message).toMatch(/alternate user\/assistant turns/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts history that ends with an assistant turn', async () => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      jsonMode: false,
      history: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    });

    expect(result).toBe('ok');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('throws a validation error when a tool turn is missing a requested tool result', async () => {
    const { client, create } = createMockClient([textResponse('unused')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    let err: LLMError | undefined;
    try {
      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          {
            role: 'assistant',
            toolCalls: [
              { id: 'call_1', name: 'get_weather', arguments: {} },
              { id: 'call_2', name: 'get_time', arguments: {} },
            ],
          },
          {
            role: 'tool',
            toolResults: [{ toolCallId: 'call_1', content: 'sunny' }],
          },
        ],
      });
    } catch (e) {
      err = e as LLMError;
    }

    expect(err?.type).toBe('invalid_params');
    expect(err?.code).toBe('missing_tool_results');
    expect(err?.issues).toEqual({ historyIndex: 1, ids: ['call_2'] });
    expect(err?.message).toMatch(/missing toolResults/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws a validation error when an assistant tool call is followed by a non-tool turn', async () => {
    const { client, create } = createMockClient([textResponse('unused')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    let err: LLMError | undefined;
    try {
      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }],
          },
          {
            role: 'user',
            content: 'actually never mind',
          },
        ],
      });
    } catch (e) {
      err = e as LLMError;
    }

    expect(err?.type).toBe('invalid_params');
    expect(err?.message).toMatch(/tool request without.*tool results|required tool results/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws code: "unknown_tool_result_ids" with the offending index and ids when toolResults reference an id that was never requested', async () => {
    const { client, create } = createMockClient([textResponse('unused')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    let err: LLMError | undefined;
    try {
      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }],
          },
          {
            role: 'tool',
            toolResults: [
              { toolCallId: 'call_1', content: 'sunny' },
              { toolCallId: 'call_ghost', content: 'x' },
            ],
          },
        ],
      });
    } catch (e) {
      err = e as LLMError;
    }

    expect(err?.type).toBe('invalid_params');
    expect(err?.code).toBe('unknown_tool_result_ids');
    expect(err?.issues).toEqual({ historyIndex: 1, ids: ['call_ghost'] });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws code: "duplicate_tool_result_ids" with the offending index and ids when the same toolCallId appears twice', async () => {
    const { client, create } = createMockClient([textResponse('unused')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    let err: LLMError | undefined;
    try {
      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }],
          },
          {
            role: 'tool',
            toolResults: [
              { toolCallId: 'call_1', content: 'sunny' },
              { toolCallId: 'call_1', content: 'sunny again' },
            ],
          },
        ],
      });
    } catch (e) {
      err = e as LLMError;
    }

    expect(err?.type).toBe('invalid_params');
    expect(err?.code).toBe('duplicate_tool_result_ids');
    expect(err?.issues).toEqual({ historyIndex: 1, ids: ['call_1'] });
    expect(create).not.toHaveBeenCalled();
  });
});
