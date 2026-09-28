import { describe, expect, it, vi } from 'vitest';

import { fromAnthropic, type AnthropicClient } from '../../../src/adapters/claude/index.js';
import { fromGemini, type GeminiClient } from '../../../src/adapters/gemini/index.js';
import { fromOpenAICompatible } from '../../../src/adapters/openai/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../helpers.js';

describe('Reasoning budget integration', () => {
  it('OpenAI-compatible: budgetTokens converts to reasoning_effort on the wire, reasoningTokens comes back via onUsage', async () => {
    const onUsage = vi.fn();

    const { client: rawClient, create } = createMockClient([
      jsonResponse(
        { answer: 'ok' },
        {
          prompt_tokens: 10,
          completion_tokens: 50,
          total_tokens: 60,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      ),
    ]);

    // `createMockClient` builds a raw `LLMClient`, matching the wire shape
    // directly, no adapter in front of it. The budget_tokens -> reasoning_effort
    // conversion for OpenAI-compatible providers lives in `fromOpenAICompatible`
    // itself (see applyReasoningBudget in adapters/openai/reasoning.ts), not in
    // `requestBuilder`, so this test needs the real adapter wrapping the mock
    // to exercise that conversion, unlike the other three providers below,
    // whose adapters vernLLM constructs directly.
    const client = fromOpenAICompatible(rawClient);

    const llm = new VernLLM({ client, model: 'gpt-test', onUsage });

    await llm.call({
      userContent: 'hello',
      budgetTokens: 20000,
      jsonMode: true,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: 'high' }),
      expect.anything(),
    );
    expect('budget_tokens' in create.mock.calls[0]![0]).toBe(false);

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 50, reasoningTokens: 30 }),
    );
  });

  it('Anthropic: budgetTokens reaches thinking.budget_tokens, thinking_tokens comes back as reasoningTokens', async () => {
    const onUsage = vi.fn();

    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 10,
        output_tokens: 40,
        output_tokens_details: { thinking_tokens: 25 },
      },
    }));

    const llm = new VernLLM({
      client: fromAnthropic({ messages: { create } }),
      model: 'claude-test',
      onUsage,
    });

    await llm.call({ userContent: 'hello', budgetTokens: 9000, maxTokens: 12000, jsonMode: false });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { type: 'enabled', budget_tokens: 9000 } }),
      expect.anything(),
    );

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 40, reasoningTokens: 25 }),
    );
  });

  it('Gemini 3: reasoningEffort maps directly onto thinkingConfig.thinkingLevel, thoughtsTokenCount comes back as reasoningTokens', async () => {
    const onUsage = vi.fn();

    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 35,
        totalTokenCount: 40,
        thoughtsTokenCount: 18,
      },
    }));

    const llm = new VernLLM({
      client: fromGemini({ models: { generateContent } }),
      model: 'gemini-3.1-flash-lite',
      onUsage,
    });

    await llm.call({ userContent: 'hello', reasoningEffort: 'low', jsonMode: false });

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ thinkingConfig: { thinkingLevel: 'LOW' } }),
      }),
    );

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 35, reasoningTokens: 18 }),
    );
  });

  it('Gemini 2.5: reasoningEffort still converts to thinkingConfig.thinkingBudget, unchanged', async () => {
    const onUsage = vi.fn();

    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 35,
        totalTokenCount: 40,
        thoughtsTokenCount: 18,
      },
    }));

    const llm = new VernLLM({
      client: fromGemini({ models: { generateContent } }),
      model: 'gemini-2.5-flash',
      onUsage,
    });

    await llm.call({ userContent: 'hello', reasoningEffort: 'low', jsonMode: false });

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ thinkingConfig: { thinkingBudget: 4096 } }),
      }),
    );

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 35, reasoningTokens: 18 }),
    );
  });
});
