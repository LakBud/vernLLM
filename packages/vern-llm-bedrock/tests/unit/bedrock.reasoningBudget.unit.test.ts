import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { stubbedClient, type ConverseHandler } from '../helpers.js';

function makeFakeBedrockClient(text: string) {
  const converse = vi.fn<ConverseHandler>(async () => ({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: stubbedClient({ converse }), converse };
}

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

  it('throws invalid_params when budget_tokens is below the 1024 minimum for a Claude model', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');

    await expect(
      fromBedrock(client).chat.completions.create(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100000,
          budget_tokens: 500,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'invalid_params',
      message: expect.stringMatching(/minimum of 1024/),
    });

    expect(converse).not.toHaveBeenCalled();
  });

  it('throws invalid_params at construction when reasoningEffortTokens tiers are out of order', () => {
    const { client } = makeFakeBedrockClient('hi');

    expect(() => fromBedrock(client, { reasoningEffortTokens: { low: 40000 } })).toThrow(
      /strictly ascending order/,
    );
  });

  describe('claudeModels, for ids that do not name the model', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';

    function create(
      client: ReturnType<typeof makeFakeBedrockClient>['client'],
      claudeModels?: string[],
    ) {
      return fromBedrock(client, { claudeModels }).chat.completions.create(
        {
          model: arn,
          max_tokens: 100000,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );
    }

    it('drops the reasoning budget for an ARN that is not listed', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');

      await create(client);

      expect(converse.mock.calls[0]![0].additionalModelRequestFields).toBeUndefined();
    });

    it('forwards the reasoning budget for an ARN that is listed', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');

      await create(client, [arn]);

      expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({
        thinking: { type: 'enabled', budget_tokens: 9000 },
      });
    });
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

    it.each([
      { budget: 500, effort: 'low' },
      { budget: 3000, effort: 'low' },
      { budget: 10000, effort: 'medium' },
      { budget: 40000, effort: 'high' },
    ])(
      'converts budget_tokens $budget into effort $effort when the model is adaptive-only',
      async ({ budget, effort }) => {
        const { client, converse } = makeFakeBedrockClient('hi');

        await fromBedrock(client).chat.completions.create(
          {
            model: 'anthropic.claude-sonnet-5-20260101-v1:0',
            max_tokens: 100000,
            budget_tokens: budget,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        );

        expect(converse.mock.calls[0]![0].outputConfig).toEqual({ effort });
      },
    );

    it.each([
      {
        model: 'anthropic.claude-opus-4-6-v1:0',
        thinking: { type: 'enabled', budget_tokens: 8000 },
      },
      { model: 'anthropic.claude-opus-4-7-v1:0', thinking: { type: 'adaptive' } },
    ])('reads the minor version of $model', async ({ model, thinking }) => {
      const { client, converse } = makeFakeBedrockClient('hi');

      await fromBedrock(client).chat.completions.create(
        {
          model,
          max_tokens: 100000,
          budget_tokens: 8000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse.mock.calls[0]![0].additionalModelRequestFields).toEqual({ thinking });
    });

    it('reads an Opus id with no minor version as that major release', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');

      await fromBedrock(client).chat.completions.create(
        {
          model: 'anthropic.claude-opus-5-v1:0',
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

    it('never applies the 1024/max_tokens budget_tokens validation on the adaptive path', async () => {
      const { client, converse } = makeFakeBedrockClient('hi');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-opus-5-20260101-v1:0',
          max_tokens: 1000, // would fail the budget_tokens check on the manual path
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
