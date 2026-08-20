import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../../../src/adapters/index.js';
import { LLMError } from '../../../../src/types/errors.js';

/**
 * Minimal fake `BedrockRuntimeClient`-shaped object: just `.send()`, since
 * that's all `fromBedrock` relies on structurally to detect and drive a raw
 * AWS SDK client. Records every command it was sent so tests can assert on
 * the real `ConverseCommand`/`ConverseStreamCommand` instances built
 * internally, not a hand-rolled stand-in for them.
 */
function makeFakeAwsClient(sendImpl: (command: unknown, options?: unknown) => Promise<unknown>) {
  const send = vi.fn(sendImpl);
  return { client: { send }, send };
}

describe('fromBedrock, given a raw AWS SDK client directly (.send() only)', () => {
  it('detects a .send()-only client structurally and drives it via real ConverseCommand instances', async () => {
    const { client, send } = makeFakeAwsClient(async () => ({
      output: { message: { content: [{ text: 'hi there' }] } },
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    }));

    // fromBedrock is synchronous even for a raw AWS client: the SDK import
    // is deferred to the first real call, not awaited here.
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('hi there');
    expect(send).toHaveBeenCalledTimes(1);

    // The command sent must be a real `ConverseCommand` instance (not a
    // plain object matching its shape), since that's what carries the AWS
    // SDK's serialization/middleware metadata `.send()` needs.
    const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ConverseCommand);
  });

  it('still accepts a hand-written BedrockConverseClient (.converse()) exactly as before', async () => {
    const converse = vi.fn(async () => ({
      output: { message: { content: [{ text: 'from a hand-written wrapper' }] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    const adapted = fromBedrock({ converse });

    const result = await adapted.chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('from a hand-written wrapper');
    expect(converse).toHaveBeenCalledTimes(1);
  });

  it('forwards the abort signal as .send()s second-argument abortSignal option', async () => {
    const { client, send } = makeFakeAwsClient(async () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    const adapted = fromBedrock(client);
    const controller = new AbortController();

    await adapted.chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
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

    const adapted = fromBedrock(client);
    const createStream = adapted.chat.completions.createStream;
    if (!createStream) throw new Error('fromBedrock should always define createStream');

    const chunks: unknown[] = [];

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
    // `wrapAwsSendClient` rejects, same as Node's real module-resolution
    // failure. Scoped to this one test via vi.doMock (not hoisted, unlike
    // vi.mock) + vi.resetModules(), re-importing the adapter module fresh
    // so every other test in this file keeps using the real AWS SDK.
    //
    // `fromBedrock` itself never touches the SDK just from being called
    // with a raw client; the dynamic import only actually runs, and can
    // only actually fail, the first time a real request is made
    // (`create`/`createStream`), exactly like this failure would only
    // surface on the first call through a hand-rolled `.converse()`
    // wrapper too.
    vi.resetModules();
    vi.doMock('@aws-sdk/client-bedrock-runtime', () => {
      throw new Error("Cannot find module '@aws-sdk/client-bedrock-runtime'");
    });

    try {
      const { fromBedrock: fromBedrockWithMissingSdk } =
        await import('../../../../src/adapters/index.js');
      const { LLMError: LLMErrorReimported } = await import('../../../../src/types/errors.js');

      const client = { send: vi.fn() };
      const adapted = fromBedrockWithMissingSdk(client);

      const call = () =>
        adapted.chat.completions.create(
          { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
          { signal: new AbortController().signal },
        );

      await expect(call()).rejects.toBeInstanceOf(LLMErrorReimported);
      await expect(call()).rejects.toMatchObject({
        message: expect.stringMatching(/@aws-sdk\/client-bedrock-runtime.*installed/i),
      });
      await expect(call()).rejects.toMatchObject({
        message: expect.stringMatching(/\.converse\(\)\/\.converseStream\(\)/),
      });
    } finally {
      vi.doUnmock('@aws-sdk/client-bedrock-runtime');
      vi.resetModules();
    }
  });
});

describe('fromBedrock + a raw AWS client, ConverseStreamCommandOutput.stream typing gap', () => {
  it('throws a clear LLMError instead of crashing on `for await` when AWS omits `stream` from the response', async () => {
    // AWS types ConverseStreamCommandOutput.stream as optional
    // (`stream?: AsyncIterable<ConverseStreamOutput> | undefined`), unlike
    // BedrockConverseClient['converseStream'], which always returns
    // `{ stream: AsyncIterable<...> }`. A response missing it (the
    // documented-possible case) must fail loudly here, not surface as an
    // opaque "stream is not async iterable" once fromBedrock's internal
    // `for await` loop gets to it.
    const { client } = makeFakeAwsClient(async () => ({}));

    const adapted = fromBedrock(client);
    const createStream = adapted.chat.completions.createStream;
    if (!createStream) throw new Error('fromBedrock should always define createStream');

    const iterate = async () => {
      for await (const _chunk of createStream(
        { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      )) {
        // draining is enough to trigger the error
      }
    };

    await expect(iterate()).rejects.toBeInstanceOf(LLMError);
    await expect(iterate()).rejects.toMatchObject({
      message: expect.stringMatching(/did not include a stream/i),
    });
  });
});

describe('fromBedrock + a raw AWS client, ConverseStreamOutput union typing gap ($unknown members)', () => {
  it('silently drops event kinds it does not model (e.g. AWS-generated $unknown), instead of misrouting or crashing on them', async () => {
    // AWS's real ConverseStreamOutput union additionally includes a
    // generated `$unknown` member (its forward-compatibility escape hatch
    // for event kinds added after this SDK version was generated), which
    // BedrockConverseStreamEvent intentionally doesn't model. Such events
    // must be filtered out before reaching fromBedrock's event loop, not
    // reach it unnarrowed as if they matched one of the handled shapes.
    async function* rawStreamWithUnknownEvents() {
      yield { messageStart: { role: 'assistant' } };
      // AWS's own forward-compatibility shape for an unrecognized event:
      // every known member absent, `$unknown` set to the raw [key, value].
      yield { $unknown: ['someFutureEventType', { anything: 'here' }] };
      yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hey' } } };
      // A second, differently-shaped unrecognized event, to confirm this
      // isn't special-cased to just the literal `$unknown` key.
      yield { someOtherFutureField: { whatever: true } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    }

    const { client } = makeFakeAwsClient(async () => ({ stream: rawStreamWithUnknownEvents() }));

    const adapted = fromBedrock(client);
    const createStream = adapted.chat.completions.createStream;
    if (!createStream) throw new Error('fromBedrock should always define createStream');

    const chunks: unknown[] = [];

    for await (const chunk of createStream(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )) {
      chunks.push(chunk);
    }

    // The real events still come through untouched...
    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'text-delta', delta: 'hey' },
        { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]),
    );

    // ...and nothing derived from the unrecognized events (which have no
    // handled shape at all) leaked through as extra, malformed chunks.
    expect(chunks).toHaveLength(2);
  });
});
