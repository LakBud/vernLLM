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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(response.usage?.completion_tokens_details).toBeUndefined();
  });

  it('omits temperature when manual thinking (budget_tokens) is set, even the instance default', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100000,
        temperature: 0.2, // simulates VernLLM's own instance/call default
        budget_tokens: 8000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in create.mock.calls[0]![0]).toBe(false);
  });

  it('keeps temperature when neither budget_tokens nor reasoning_effort is set', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100000,
        temperature: 0.5,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(create.mock.calls[0]![0].temperature).toBe(0.5);
  });

  it("throws invalid_params when budget_tokens is below Anthropic's 1024 minimum", async () => {
    const { client } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 100000,
          budget_tokens: 500,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/below Anthropic's minimum of 1024/);
  });

  it('throws invalid_params when budget_tokens is not strictly less than max_tokens', async () => {
    const { client } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 1000, // VernLLM's own default
          budget_tokens: 1024, // the default "minimal" tier, invalid against this max_tokens
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/must be less than maxTokens/);
  });

  it('sends manual budget_tokens, not adaptive thinking, for a real snapshot-dated base Opus 4 model', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-opus-4-20250514', // real base Opus 4 id, no ".7"-style minor
        max_tokens: 100000,
        budget_tokens: 8000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
  });

  describe('adaptive-only models (Claude Opus 4.7 and later, every Claude 5 model)', () => {
    it('sends adaptive thinking plus output_config.effort instead of budget_tokens', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 100000,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sent = create.mock.calls[0]![0];
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect(sent.output_config).toEqual({ effort: 'high' });
      expect('budget_tokens' in (sent.thinking as object)).toBe(false);
    });

    it('converts an explicit budget_tokens into the nearest effort tier on an adaptive-only model', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-opus-5',
          max_tokens: 100000,
          budget_tokens: 20000, // buckets to 'high' against the default table
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sent = create.mock.calls[0]![0];
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect(sent.output_config).toEqual({ effort: 'high' });
    });

    it("maps VernLLM's 'minimal' tier onto Anthropic's 'low', the nearest available tier", async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-opus-4-8',
          max_tokens: 100000,
          reasoning_effort: 'minimal',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create.mock.calls[0]![0].output_config).toEqual({ effort: 'low' });
    });

    it('omits temperature on the adaptive path too, not just the manual budget_tokens path', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 100000,
          temperature: 0.2,
          reasoning_effort: 'medium',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect('temperature' in create.mock.calls[0]![0]).toBe(false);
    });

    it('never applies the 1024/max_tokens budget_tokens validation on the adaptive path', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client);

      // max_tokens: 1000 would fail assertValidClaudeBudgetTokens on the
      // manual path (see the throwing test above); on an adaptive-only
      // model it must not, since no budget_tokens is ever sent.
      await adapted.chat.completions.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 1000,
          reasoning_effort: 'low',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'adaptive' });
    });

    it('merges effort into output_config alongside format when jsonSchema and reasoning are both set', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client, {
        nativeStructuredOutputModels: ['claude-sonnet-5'],
      });

      await adapted.chat.completions.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 100000,
          reasoning_effort: 'high',
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'x', schema: { type: 'object', properties: {} } },
          },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create.mock.calls[0]![0].output_config).toEqual({
        format: { type: 'json_schema', schema: { type: 'object', properties: {} } },
        effort: 'high',
      });
    });

    it('adaptiveOnlyModels lets a caller mark an additional model as adaptive-only', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client, { adaptiveOnlyModels: ['claude-nova-1'] });

      await adapted.chat.completions.create(
        {
          model: 'claude-nova-1',
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sent = create.mock.calls[0]![0];
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect('budget_tokens' in (sent.thinking as object)).toBe(false);
    });

    it('adaptiveOnlyModels has no effect on a model not in the override', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      const adapted = fromAnthropic(client, { adaptiveOnlyModels: ['claude-nova-1'] });

      await adapted.chat.completions.create(
        {
          model: 'claude-x', // not covered by the override, not covered by the built-in rule either
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    });

    it('adaptiveOnlyModels cannot un-mark a model the built-in rule already caught', async () => {
      const { client, create } = makeFakeAnthropicClient('hi');
      // An override that only lists an unrelated model must not somehow
      // exempt claude-sonnet-5 from the built-in rule.
      const adapted = fromAnthropic(client, { adaptiveOnlyModels: ['claude-nova-1'] });

      await adapted.chat.completions.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create.mock.calls[0]![0].thinking).toEqual({ type: 'adaptive' });
    });
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

describe('fromGemini reasoning budget (Gemini 2.5 and earlier, thinkingBudget)', () => {
  it('sends budget_tokens directly onto config.thinkingConfig.thinkingBudget', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(response.usage?.completion_tokens_details).toBeUndefined();
  });
});

describe('fromGemini reasoning budget (Gemini 3 and later, thinkingLevel)', () => {
  it('maps reasoning_effort directly onto thinkingLevel, no conversion table needed', async () => {
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
      thinkingLevel: 'LOW',
    });
  });

  it('converts budget_tokens to the nearest effort tier, then maps that tier onto thinkingLevel', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        budget_tokens: 20000, // buckets to 'high' against the default table
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
    });
  });

  it('prefers reasoning_effort over budget_tokens when both are set, matching the adaptive-only Anthropic precedent', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        reasoning_effort: 'minimal',
        budget_tokens: 32000, // would bucket to 'high' if used instead
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingLevel: 'MINIMAL',
    });
  });

  it("collapses 0 and -1 to 'minimal', the closest available approximation, instead of using them literally", async () => {
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
      thinkingLevel: 'MINIMAL',
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
      thinkingLevel: 'MINIMAL',
    });
  });

  it('omits thinkingConfig entirely when neither budget_tokens nor reasoning_effort is set', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toBeUndefined();
  });

  it('lets thinkingLevelModels mark an additional model as using thinkingLevel', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client, { thinkingLevelModels: ['gemini-nova-1'] });

    await adapted.chat.completions.create(
      {
        model: 'gemini-nova-1',
        max_tokens: 200,
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
    });
  });

  it('thinkingLevelModels cannot un-mark a model the built-in threshold already caught', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client, { thinkingLevelModels: ['gemini-nova-1'] });

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite', // not in the override, but still Gemini 3+
        max_tokens: 200,
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
    });
  });

  it('maps usageMetadata.thoughtsTokenCount the same way as on Gemini 2.5', async () => {
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
});

describe('fromBedrock reasoning budget', () => {
  it('forwards budget_tokens as additionalModelRequestFields for a Claude model', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
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
        max_tokens: 100000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('additionalModelRequestFields' in converse.mock.calls[0]![0]).toBe(false);
  });

  it('omits temperature when manual thinking (budget_tokens) is set on a Claude model', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 100000,
        temperature: 0.2,
        budget_tokens: 8000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in converse.mock.calls[0]![0].inferenceConfig!).toBe(false);
  });

  it('keeps temperature for a non-Claude model, budgetTokens has no effect on it there', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'amazon.titan-text-premier-v1:0',
        max_tokens: 100000,
        temperature: 0.7,
        budget_tokens: 8000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].inferenceConfig!.temperature).toBe(0.7);
  });

  it('throws invalid_params when budget_tokens is not strictly less than max_tokens for a Claude model', async () => {
    const { client } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 1000,
          budget_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/must be less than maxTokens/);
  });

  it('sends manual budget_tokens, not adaptive thinking, for a real snapshot-dated base Opus 4 model on Bedrock', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-opus-4-20250514-v1:0', // real base Opus 4 id, no ".7"-style minor
        max_tokens: 100000,
        budget_tokens: 8000,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
  });

  describe('adaptive-only Claude models on Bedrock (Opus 4.7 and later, every Claude 5 model)', () => {
    it('sends adaptive thinking plus outputConfig.effort instead of budget_tokens', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-sonnet-5-20260101-v1:0',
          max_tokens: 100000,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sent = converse.mock.calls[0]![0];
      expect(sent.additionalModelRequestFields).toEqual({ thinking: { type: 'adaptive' } });
      expect(sent.outputConfig).toEqual({ effort: 'high' });
    });

    it('never applies the 1024/max_tokens budget_tokens validation on the adaptive path', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-opus-5-20260101-v1:0',
          max_tokens: 1000, // would fail assertValidClaudeBudgetTokens on the manual path
          reasoning_effort: 'low',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
        thinking: { type: 'adaptive' },
      });
    });

    it('omits temperature on the adaptive path too', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-sonnet-5-20260101-v1:0',
          max_tokens: 100000,
          temperature: 0.2,
          reasoning_effort: 'medium',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect('temperature' in converse.mock.calls[0]![0].inferenceConfig!).toBe(false);
    });

    it('adaptiveOnlyModels lets a caller mark an additional Claude model as adaptive-only', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');
      const adapted = fromBedrock(client, {
        adaptiveOnlyModels: ['anthropic.claude-nova-1-v1:0'],
      });

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-nova-1-v1:0',
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
        thinking: { type: 'adaptive' },
      });
    });

    it('adaptiveOnlyModels cannot un-mark a Claude model the built-in rule already caught', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');
      const adapted = fromBedrock(client, {
        adaptiveOnlyModels: ['anthropic.claude-nova-1-v1:0'],
      });

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-sonnet-5-20260101-v1:0',
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
        thinking: { type: 'adaptive' },
      });
    });
  });
});
