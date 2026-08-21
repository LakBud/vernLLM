import { describe, expect, it, vi } from 'vitest';

import { fromAnthropic, type AnthropicClient } from '../../../src/adapters/anthropic.js';
import { fromBedrock, type BedrockConverseClient } from '../../../src/adapters/bedrock.js';
import { fromGemini, type GeminiClient } from '../../../src/adapters/gemini.js';
import { fromOpenAICompatible } from '../../../src/adapters/openaiCompatible.js';
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
    // itself (see applyReasoningBudget in adapters/openaiCompatible.ts), not in
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

    await llm.call({ userContent: 'hello', budgetTokens: 9000, jsonMode: false });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { type: 'enabled', budget_tokens: 9000 } }),
      expect.anything(),
    );

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 40, reasoningTokens: 25 }),
    );
  });

  it('Gemini: reasoningEffort converts to thinkingConfig.thinkingBudget, thoughtsTokenCount comes back as reasoningTokens', async () => {
    const onUsage = vi.fn();

    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 35,
        totalTokenCount: 40,
        thoughtsTokenCount: 18,
      },
    }));

    const llm = new VernLLM({
      client: fromGemini({ generateContent }),
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

  it('Bedrock: budgetTokens reaches additionalModelRequestFields for a Claude model, reasoningTokens stays undefined (no native field)', async () => {
    const onUsage = vi.fn();

    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 },
    }));

    const llm = new VernLLM({
      client: fromBedrock({ converse }),
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      onUsage,
    });

    await llm.call({ userContent: 'hello', budgetTokens: 12000, jsonMode: false });

    expect(converse).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 12000 } },
      }),
      expect.anything(),
    );

    const reported = onUsage.mock.calls[0]![0];
    expect(reported.completionTokens).toBe(30);
    expect(reported.reasoningTokens).toBeUndefined();
  });

  it('Bedrock: budgetTokens dropped for a non-Claude model, end to end through VernLLM.call()', async () => {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 },
    }));

    const llm = new VernLLM({
      client: fromBedrock({ converse }),
      model: 'amazon.titan-text-premier-v1:0',
    });

    await llm.call({ userContent: 'hello', budgetTokens: 12000, jsonMode: false });

    expect('additionalModelRequestFields' in converse.mock.calls[0]![0]).toBe(false);
  });
});
