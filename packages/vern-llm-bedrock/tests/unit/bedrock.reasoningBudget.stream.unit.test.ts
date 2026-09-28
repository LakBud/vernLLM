import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { collect, fakeStream, stubbedClient, type ConverseHandler } from '../helpers.js';

describe('fromBedrock().chat.completions.createStream reasoning budget', () => {
  function makeFakeStreamingBedrockClient(events: unknown[]) {
    const converse = vi.fn<ConverseHandler>(async () => ({}));
    const converseStream = vi.fn(async (_params: unknown, _options: unknown) => ({
      stream: fakeStream(events),
    }));

    return {
      client: stubbedClient({ converse, converseStream }),
      converseStream,
    };
  }

  it('forwards budget_tokens as additionalModelRequestFields for a Claude model', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100000,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(converseStream.mock.calls[0]![0]).toMatchObject({
      additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 9000 } },
    });
  });

  it('sends adaptive thinking plus outputConfig.effort on an adaptive-only Claude model', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-sonnet-5-20260101-v1:0',
          max_tokens: 100000,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(converseStream.mock.calls[0]![0]).toMatchObject({
      additionalModelRequestFields: { thinking: { type: 'adaptive' } },
      outputConfig: { effort: 'high' },
    });
  });

  it('omits temperature on the stream path whenever thinking is present for a Claude model', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100000,
          temperature: 0.2,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(
      'temperature' in
        ((converseStream.mock.calls[0]![0] as { inferenceConfig?: Record<string, unknown> })
          .inferenceConfig ?? {}),
    ).toBe(false);
  });

  it('drops budget_tokens for a non-Claude model on the stream path too', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    const adapted = fromBedrock(client);

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'amazon.titan-text-premier-v1:0',
          max_tokens: 100000,
          budget_tokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(
      'additionalModelRequestFields' in
        (converseStream.mock.calls[0]![0] as Record<string, unknown>),
    ).toBe(false);
  });
});
