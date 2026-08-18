import { describe, it, expect, vi } from 'vitest';

import { fromBedrockClient } from '../../../../src/adapters/index.js';

/**
 * Minimal fake `BedrockRuntimeClient`-shaped object: just `.send()`, since
 * that's all `fromBedrockClient` relies on structurally. Records every
 * command it was sent so tests can assert on the real `ConverseCommand`/
 * `ConverseStreamCommand` instances built internally, not a hand-rolled
 * stand-in for them.
 */
function makeFakeAwsClient(sendImpl: (command: unknown, options?: unknown) => Promise<unknown>) {
  const send = vi.fn(sendImpl);
  return { client: { send }, send };
}

describe('fromBedrockClient', () => {
  it('wraps a real AWS SDK v3 client (.send only) with no hand-written .converse()/.converseStream() wrapper required', async () => {
    const { client, send } = makeFakeAwsClient(async () => ({
      output: { message: { content: [{ text: 'hi there' }] } },
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    }));

    const adapted = await fromBedrockClient(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('hi there');
    expect(send).toHaveBeenCalledTimes(1);

    // The command sent must be a real `ConverseCommand` instance (not a
    // plain object matching its shape), since that's what carries the AWS
    // SDK's serialization/middleware metadata `.send()` needs.
    const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const sentCommand = send.mock.calls[0]?.[0];
    expect(sentCommand).toBeInstanceOf(ConverseCommand);
  });

  it('forwards the abort signal as .send()s second-argument abortSignal option', async () => {
    const { client, send } = makeFakeAwsClient(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    const adapted = await fromBedrockClient(client);
    const controller = new AbortController();

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: controller.signal },
    );

    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });

  it('uses ConverseStreamCommand for streaming calls', async () => {
    async function* fakeStream() {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hey' } } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    }

    const { client, send } = makeFakeAwsClient(async () => ({ stream: fakeStream() }));

    const adapted = await fromBedrockClient(client);

    const chunks: unknown[] = [];
    const createStream = adapted.chat.completions.createStream;
    if (!createStream) throw new Error('fromBedrockClient should always define createStream');

    for await (const chunk of createStream(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(expect.arrayContaining([{ type: 'text-delta', delta: 'hey' }]));

    const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ConverseStreamCommand);
  });

  it('throws a clear, actionable LLMError instead of a raw module-resolution error when @aws-sdk/client-bedrock-runtime cannot be imported', async () => {
    // Simulates the package not being installed: `import()` inside
    // `fromBedrockClient` rejects, same as Node's real module-resolution
    // failure. Scoped to this one test via vi.doMock (not hoisted, unlike
    // vi.mock) + vi.resetModules(), re-importing the adapter module fresh
    // so every other test in this file keeps using the real AWS SDK.
    vi.resetModules();
    vi.doMock('@aws-sdk/client-bedrock-runtime', () => {
      throw new Error("Cannot find module '@aws-sdk/client-bedrock-runtime'");
    });

    try {
      const { fromBedrockClient: fromBedrockClientWithMissingSdk } =
        await import('../../../../src/adapters/index.js');
      const { LLMError } = await import('../../../../src/types/errors.js');

      const client = { send: vi.fn() };

      await expect(fromBedrockClientWithMissingSdk(client)).rejects.toBeInstanceOf(LLMError);
      await expect(fromBedrockClientWithMissingSdk(client)).rejects.toMatchObject({
        message: expect.stringMatching(/@aws-sdk\/client-bedrock-runtime.*installed/i),
      });
      await expect(fromBedrockClientWithMissingSdk(client)).rejects.toMatchObject({
        message: expect.stringMatching(/fromBedrock\(converseClient\)/),
      });
    } finally {
      vi.doUnmock('@aws-sdk/client-bedrock-runtime');
      vi.resetModules();
    }
  });
});
