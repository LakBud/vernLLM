import { describe, it, expect } from 'vitest';

import { LLMError } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { at, createMockClient, textResponse } from '../helpers.js';

describe('VernLLM.call — conversation history', () => {
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
});

describe('VernLLM.call — conversation history validation', () => {
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

    expect(err?.type).toBe('validation');
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

    expect(err?.type).toBe('validation');
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

    expect(err?.type).toBe('validation');
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

    expect(err?.type).toBe('validation');
    expect(err?.message).toMatch(/tool request without.*tool results|required tool results/i);
    expect(create).not.toHaveBeenCalled();
  });
});
