import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { LLMError } from 'vern-llm';
import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';

/**
 * A real `BedrockRuntimeClient` with `send` stubbed by `sendImpl`, so each
 * test sees the exact command instances and options `fromBedrock` sends.
 */
function makeClient(sendImpl: (command: unknown, options?: unknown) => Promise<unknown>) {
  const client = new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const send = vi
    .spyOn(client, 'send')
    .mockImplementation(sendImpl as unknown as BedrockRuntimeClient['send']);

  return { client, send };
}

const request = {
  model: 'm',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

async function drain(client: BedrockRuntimeClient): Promise<unknown[]> {
  const chunks: unknown[] = [];

  for await (const chunk of fromBedrock(client).chat.completions.createStream!(request, {
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }

  return chunks;
}

describe('fromBedrock, driving a BedrockRuntimeClient', () => {
  it('sends a real ConverseCommand carrying the built request', async () => {
    const { client, send } = makeClient(async () => ({
      output: { message: { content: [{ text: 'hi there' }] } },
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    }));

    const result = await fromBedrock(client).chat.completions.create(request, {
      signal: new AbortController().signal,
    });

    expect(result.choices?.[0]?.message?.content).toBe('hi there');
    expect(send).toHaveBeenCalledTimes(1);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConverseCommand);
    expect((command as ConverseCommand).input).toMatchObject({
      modelId: 'm',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    });
  });

  it('forwards the abort signal as the abortSignal send option', async () => {
    const { client, send } = makeClient(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
    }));
    const controller = new AbortController();

    await fromBedrock(client).chat.completions.create(request, { signal: controller.signal });

    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
  });

  it('uses ConverseStreamCommand for streaming calls', async () => {
    async function* stream() {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hey' } } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    }

    const { client, send } = makeClient(async () => ({ stream: stream() }));

    expect(await drain(client)).toEqual(
      expect.arrayContaining([{ type: 'text-delta', delta: 'hey' }]),
    );
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ConverseStreamCommand);
  });

  it.each([
    ['internalServerException', { message: 'Something went wrong on AWS' }, { status: 500 }],
    ['validationException', { message: 'Malformed request' }, { type: 'validation' }],
    ['throttlingException', { message: 'Too many requests' }, { status: 429 }],
    [
      'serviceUnavailableException',
      { message: 'Bedrock is temporarily unavailable' },
      { status: 503 },
    ],
    [
      'modelStreamErrorException',
      { message: 'Model stream failed', originalStatusCode: 424 },
      { status: 424 },
    ],
  ] as const)(
    'surfaces a %s stream event as a classified LLMError',
    async (key, body, expected) => {
      async function* stream() {
        yield { [key]: body };
      }

      const { client } = makeClient(async () => ({ stream: stream() }));
      const rejection = await drain(client).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(LLMError);
      expect(rejection).toMatchObject({ ...expected, message: body.message });
    },
  );

  it.each([
    ['internalServerException', 'Bedrock reported a mid-stream error'],
    ['validationException', 'Bedrock rejected the request mid-stream'],
    ['throttlingException', 'Bedrock throttled the request mid-stream'],
  ] as const)('falls back to a default message when a %s has none', async (key, message) => {
    async function* stream() {
      yield { [key]: { message: '' } };
    }

    const { client } = makeClient(async () => ({ stream: stream() }));

    await expect(drain(client)).rejects.toMatchObject({ message });
  });

  it('throws a clear LLMError when the response has no stream', async () => {
    // The SDK types `stream` as optional; without this check the loop would
    // fail with an opaque "not async iterable" error instead.
    const { client } = makeClient(async () => ({}));

    await expect(drain(client)).rejects.toBeInstanceOf(LLMError);
    await expect(drain(client)).rejects.toMatchObject({
      message: expect.stringMatching(/did not include a stream/i),
      code: 'server_error',
    });
  });

  it('skips event kinds it does not model, such as the SDK generated $unknown member', async () => {
    async function* stream() {
      yield { messageStart: { role: 'assistant' } };
      yield { $unknown: ['someFutureEventType', { anything: 'here' }] };
      yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hey' } } };
      yield { someOtherFutureField: { whatever: true } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    }

    const { client } = makeClient(async () => ({ stream: stream() }));

    expect(await drain(client)).toEqual([
      { type: 'text-delta', delta: 'hey' },
      {
        type: 'usage',
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          prompt_tokens_details: {},
        },
      },
    ]);
  });

  it('reads a missing contentBlockIndex as block 0, since the SDK types it optional', async () => {
    async function* stream() {
      yield { contentBlockStart: { start: {} } };
      yield { contentBlockDelta: { delta: { reasoningContent: { text: 'think' } } } };
      yield { contentBlockDelta: { delta: { reasoningContent: { signature: 'sig' } } } };
      yield { contentBlockStop: {} };
    }

    const { client } = makeClient(async () => ({ stream: stream() }));

    expect(await drain(client)).toEqual([
      { type: 'ping' },
      { type: 'ping' },
      { type: 'thinking_block', block: { type: 'thinking', thinking: 'think', signature: 'sig' } },
    ]);
  });

  it('names the adapter and provider for middleware and telemetry', () => {
    const { client } = makeClient(async () => ({}));

    expect(fromBedrock(client).adapter).toEqual({ name: 'bedrock', provider: 'aws.bedrock' });
  });
});
