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
import { makeFakeAnthropicClient } from '../../helpers.js';

function makeFakeOpenAICompatibleClient() {
  let received: unknown;

  return {
    fakeClient: {
      chat: {
        completions: {
          create: async (params: unknown) => {
            received = params;
            return { choices: [{ message: { content: 'ok' } }] };
          },
        },
      },
    },
    getReceived: () => received as Record<string, unknown>,
  };
}

function makeFakeGeminiClient(text: string, usageMetadata?: Record<string, unknown>) {
  const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: usageMetadata ?? {
      promptTokenCount: 4,
      candidatesTokenCount: 6,
      totalTokenCount: 10,
    },
  }));

  return { client: { generateContent }, generateContent };
}

function makeFakeBedrockClient(text: string) {
  const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: { converse }, converse };
}

describe('fromAnthropic reasoning budget', () => {
  it('sends budget_tokens directly onto thinking.budget_tokens when set', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        budget_tokens: 8000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
  });

  it('converts reasoning_effort to a token budget when budget_tokens is not set', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 32000 });
  });

  it('uses a custom reasoningEffortTokens table when converting reasoning_effort', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client, { reasoningEffortTokens: { high: 64000 } });

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 64000 });
  });

  it('prefers budget_tokens over reasoning_effort when both are set', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        budget_tokens: 5000,
        reasoning_effort: 'minimal',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
  });

  it('omits thinking entirely when neither budget_tokens nor reasoning_effort is set', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('thinking' in create.mock.calls[0]![0]).toBe(false);
  });

  it('maps output_tokens_details.thinking_tokens onto completion_tokens_details.reasoning_tokens', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 10,
        output_tokens: 50,
        output_tokens_details: { thinking_tokens: 30 },
      },
    }));
    const adapted = fromAnthropic({ messages: { create } });

    const response = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(response.usage?.completion_tokens_details).toEqual({ reasoning_tokens: 30 });
  });

  it('omits completion_tokens_details when the response has no thinking_tokens', async () => {
    const { client } = makeFakeAnthropicClient('hi', { input_tokens: 10, output_tokens: 5 });
    const adapted = fromAnthropic(client);

    const response = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(response.usage?.completion_tokens_details).toBeUndefined();
  });
});

describe('fromOpenAICompatible reasoning budget', () => {
  it('forwards reasoning_effort unchanged and leaves budget_tokens off the wire', async () => {
    const { fakeClient, getReceived } = makeFakeOpenAICompatibleClient();
    const adapted = fromOpenAICompatible(fakeClient);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        reasoning_effort: 'medium',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(getReceived().reasoning_effort).toBe('medium');
    expect('budget_tokens' in getReceived()).toBe(false);
  });

  it('converts budget_tokens to the nearest reasoning_effort tier when reasoning_effort is unset', async () => {
    const { fakeClient, getReceived } = makeFakeOpenAICompatibleClient();
    const adapted = fromOpenAICompatible(fakeClient);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        budget_tokens: 20000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(getReceived().reasoning_effort).toBe('high');
    expect('budget_tokens' in getReceived()).toBe(false);
  });

  it('uses a custom reasoningEffortTokens table when converting budget_tokens', async () => {
    const { fakeClient, getReceived } = makeFakeOpenAICompatibleClient();
    // 20000 lands in "high" against the built-in table (>16000), but this
    // override raises the "high" threshold to 25000, so it should now
    // bucket into "medium" instead.
    const adapted = fromOpenAICompatible(fakeClient, {
      reasoningEffortTokens: { medium: 22000, high: 25000 },
    });

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        budget_tokens: 20000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(getReceived().reasoning_effort).toBe('medium');
    expect('budget_tokens' in getReceived()).toBe(false);
  });

  it('prefers reasoning_effort over budget_tokens when both are set', async () => {
    const { fakeClient, getReceived } = makeFakeOpenAICompatibleClient();
    const adapted = fromOpenAICompatible(fakeClient);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        reasoning_effort: 'low',
        budget_tokens: 32000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(getReceived().reasoning_effort).toBe('low');
    expect('budget_tokens' in getReceived()).toBe(false);
  });

  it('produces an identical request body when neither field is set, no regression', async () => {
    const { fakeClient, getReceived } = makeFakeOpenAICompatibleClient();
    const adapted = fromOpenAICompatible(fakeClient);
    const params = {
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user' as const, content: 'hi' }],
    };

    await adapted.chat.completions.create(params, { signal: new AbortController().signal });

    expect(getReceived()).toEqual(params);
  });
});

describe('fromGemini reasoning budget', () => {
  it('sends budget_tokens directly onto config.thinkingConfig.thinkingBudget', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        budget_tokens: 12000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingBudget: 12000,
    });
  });

  it('preserves 0 (disabled) and -1 (automatic) as literal values, not run through the effort table', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        budget_tokens: 0,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        budget_tokens: -1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[1]![0].config?.thinkingConfig).toEqual({
      thinkingBudget: -1,
    });
  });

  it('converts reasoning_effort to a token budget when budget_tokens is unset', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingBudget: 4096,
    });
  });

  it('uses a custom reasoningEffortTokens table when converting reasoning_effort', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client, { reasoningEffortTokens: { low: 2048 } });

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingBudget: 2048,
    });
  });

  it('maps usageMetadata.thoughtsTokenCount onto completion_tokens_details.reasoning_tokens', async () => {
    const { client } = makeFakeGeminiClient('hi', {
      promptTokenCount: 4,
      candidatesTokenCount: 20,
      totalTokenCount: 24,
      thoughtsTokenCount: 15,
    });
    const adapted = fromGemini(client);

    const response = await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(response.usage?.completion_tokens_details).toEqual({ reasoning_tokens: 15 });
  });

  it('omits completion_tokens_details when usageMetadata has no thoughtsTokenCount', async () => {
    const { client } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    const response = await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(response.usage?.completion_tokens_details).toBeUndefined();
  });
});

describe('fromBedrock reasoning budget', () => {
  it('forwards budget_tokens as additionalModelRequestFields for a Claude model', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 300,
        budget_tokens: 9000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
      thinking: { type: 'enabled', budget_tokens: 9000 },
    });
  });

  it('converts reasoning_effort to a token budget for a Claude model', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 300,
        reasoning_effort: 'medium',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
      thinking: { type: 'enabled', budget_tokens: 16000 },
    });
  });

  it('uses a custom reasoningEffortTokens table when converting reasoning_effort for a Claude model', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client, { reasoningEffortTokens: { medium: 12000 } });

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 300,
        reasoning_effort: 'medium',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
      thinking: { type: 'enabled', budget_tokens: 12000 },
    });
  });

  it('drops budget_tokens for a non-Claude model instead of sending a meaningless field', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'amazon.titan-text-premier-v1:0',
        max_tokens: 300,
        budget_tokens: 9000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('additionalModelRequestFields' in converse.mock.calls[0]![0]).toBe(false);
  });

  it('omits additionalModelRequestFields entirely when no reasoning budget is set', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 300,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('additionalModelRequestFields' in converse.mock.calls[0]![0]).toBe(false);
  });
});
