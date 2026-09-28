import { VernLLM } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { stubbedClient, type ConverseHandler } from '../helpers.js';

describe('fromBedrock reasoning budget, end to end through VernLLM.call()', () => {
  it('Bedrock: budgetTokens reaches additionalModelRequestFields for a Claude model, reasoningTokens stays undefined (no native field)', async () => {
    const onUsage = vi.fn();

    const converse = vi.fn<ConverseHandler>(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 },
    }));

    const llm = new VernLLM({
      client: fromBedrock(stubbedClient({ converse })),
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      onUsage,
    });

    await llm.call({
      userContent: 'hello',
      budgetTokens: 12000,
      maxTokens: 16000,
      jsonMode: false,
    });

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
    const converse = vi.fn<ConverseHandler>(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 },
    }));

    const llm = new VernLLM({
      client: fromBedrock(stubbedClient({ converse })),
      model: 'amazon.titan-text-premier-v1:0',
    });

    await llm.call({ userContent: 'hello', budgetTokens: 12000, jsonMode: false });

    expect('additionalModelRequestFields' in converse.mock.calls[0]![0]).toBe(false);
  });
});
