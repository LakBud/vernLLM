import { describe, expect, it, vi } from 'vitest';

import { fromAnthropic } from '../../src/adapters/index.js';
import { VernLLM } from '../../src/vernLLM.js';

describe('VernLLM + adapter integration — conversation history', () => {
  it('carries history from VernLLM.call() through a real adapter to the provider call', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'About 2.1 million.' }],
          usage: { input_tokens: 20, output_tokens: 6 },
        })),
      },
    };

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const result = await llm.call({
      systemPrompt: 'You are helpful.',
      userContent: "What's its population?",
      jsonMode: false,
      history: [
        { role: 'user', content: "What's the capital of France?" },
        { role: 'assistant', content: 'Paris.' },
      ],
    });

    expect(result).toBe('About 2.1 million.');

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'You are helpful.',
        messages: [
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      }),
      expect.anything(),
    );
  });

  it('serializes non-string assistant history content, including null, before it reaches a real adapter', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        })),
      },
    };

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    await llm.call({
      userContent: 'continue',
      jsonMode: false,
      history: [
        { role: 'user', content: 'give me json' },
        { role: 'assistant', content: { name: 'Ada', skills: ['ts'] } },
        { role: 'user', content: 'and now nothing' },
        { role: 'assistant', content: null },
      ],
    });

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'give me json' },
          { role: 'assistant', content: JSON.stringify({ name: 'Ada', skills: ['ts'] }) },
          { role: 'user', content: 'and now nothing' },
          { role: 'assistant', content: JSON.stringify(null) },
          { role: 'user', content: 'continue' },
        ],
      }),
      expect.anything(),
    );
  });
});
