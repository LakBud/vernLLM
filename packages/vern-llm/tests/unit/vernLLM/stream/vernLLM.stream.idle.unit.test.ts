import { describe, expect, it } from 'vitest';

import { LLMError, type WireStreamChunk } from '../../../../src/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockStreamingClient, drain, isPending } from '../../../helpers.js';

describe('VernLLM.call, stream: true, per-chunk idle timeout', () => {
  it('fails finalResult with LLMError("timeout") when the gap between chunks exceeds chunkIdleTimeoutMs', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }

              // Never resolves within the configured idle window, the
              // idle timeout races this and wins.
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { done: false, value: { type: 'text-delta', delta: 'never seen' } };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 10 });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks).catch(() => {});

    await expect(finalResult).rejects.toMatchObject({
      name: 'LLMError',
      type: 'timeout',
    });
  });

  it('resets the idle clock on every real chunk, so a stream of many chunks each within the window still succeeds', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step >= 5) {
                return { done: true, value: undefined };
              }

              // Each individual gap is well within the idle window, even
              // though the *total* stream duration exceeds it many times
              // over, proving the clock resets per-chunk instead of
              // measuring from stream start.
              await new Promise((resolve) => setTimeout(resolve, 8));
              step++;
              return { done: false, value: { type: 'text-delta', delta: `${step} ` } };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 30 });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).resolves.toBe('1 2 3 4 5');
  });

  it('does not apply an idle timeout when chunkIdleTimeoutMs is 0 (disabled)', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { done: false, value: { type: 'text-delta', delta: 'ok' } };
              }
              return { done: true, value: undefined };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 0 });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).resolves.toBe('ok');
  });

  it('a per-call chunkIdleTimeoutMs override lets a slow call survive despite a stricter instance default', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              // Gap would exceed the instance default (10ms) but not the
              // per-call override (100ms), standing in for a
              // reasoning-heavy call on a route where the instance
              // default is otherwise tuned for fast, chatty routes.
              await new Promise((resolve) => setTimeout(resolve, 30));
              return { done: true, value: undefined };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 10 });

    const { finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      chunkIdleTimeoutMs: 100,
    });

    await expect(finalResult).resolves.toBe('first');
  });

  it('a per-call chunkIdleTimeoutMs of 0 disables the idle timeout for that call regardless of the instance default', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              await new Promise((resolve) => setTimeout(resolve, 30));
              return { done: true, value: undefined };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 10 });

    const { finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      chunkIdleTimeoutMs: 0,
    });

    await expect(finalResult).resolves.toBe('first');
  });

  it('falls back to the instance chunkIdleTimeoutMs when no per-call override is given', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { done: false, value: { type: 'text-delta', delta: 'never seen' } };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 10 });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks).catch(() => {});

    await expect(finalResult).rejects.toMatchObject({ type: 'timeout' });
  });

  it('does not treat a fast-arriving second chunk as an idle-timeout failure', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'a' },
        { type: 'text-delta', delta: 'b' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 1000 });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).resolves.toBe('ab');
  });

  it('trips the circuit breaker on an idle-timeout failure, even though real content already flowed', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { done: false, value: { type: 'text-delta', delta: 'never seen' } };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      chunkIdleTimeoutMs: 10,
      circuitBreaker: { threshold: 1 },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks).catch(() => {});
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);

    // A provider that streams one chunk then hangs never reaches
    // `finish()`, so it never records a success either, the idle timeout
    // is the only outcome recorded for this call and the breaker opens.
    expect(llm.getCircuitState()).toBe('open');
  });

  it('does not record a circuit-breaker success on first-chunk arrival, only once the stream fully completes', async () => {
    // A stream that opens, delivers one chunk, then times out must not
    // leave the circuit in a state where that timeout was ever masked by
    // an earlier success. Two back-to-back calls, both hang after their
    // first chunk, must both count toward the threshold instead of the
    // counter being reset by a premature connect-time success in between.
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { done: false, value: { type: 'text-delta', delta: 'never seen' } };
            },
          };
        },
      }),
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { done: false, value: { type: 'text-delta', delta: 'never seen' } };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      chunkIdleTimeoutMs: 10,
      circuitBreaker: { threshold: 2 },
    });

    const first = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await drain(first.chunks).catch(() => {});
    await first.finalResult.catch(() => {});

    // One failure recorded so far, below threshold: still closed.
    expect(llm.getCircuitState()).toBe('closed');

    const second = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await drain(second.chunks).catch(() => {});
    await second.finalResult.catch(() => {});

    // Two failures now: this only works if the first call's own
    // first-chunk arrival didn't reset the counter back to 0 in between.
    expect(llm.getCircuitState()).toBe('open');
  });

  it('does not trip the circuit breaker for a non-timeout mid-stream failure (e.g. a transport error)', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              throw new Error('connection reset');
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      chunkIdleTimeoutMs: 10,
      circuitBreaker: { threshold: 1 },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks).catch(() => {});
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);

    expect(llm.getCircuitState()).toBe('closed');
  });

  it("aborts the signal passed to createStream when the idle timeout fires, tearing down the transport instead of only rejecting VernLLM's own promise", async () => {
    const { client, createStream } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              // Never resolves, standing in for a transport that would
              // otherwise stay open forever if nothing tore it down.
              await new Promise(() => {});
              return { done: false, value: { type: 'text-delta', delta: 'never seen' } };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 10 });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks).catch(() => {});
    await expect(finalResult).rejects.toMatchObject({ type: 'timeout' });

    const [, options] = createStream.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(options.signal.aborted).toBe(true);
  });
});

describe('VernLLM.call, stream: true, provider keep-alive pings', () => {
  it('a ping wire chunk is not surfaced to the caller and does not appear in the accumulated text', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'Hello' },
        { type: 'ping' },
        { type: 'text-delta', delta: ', world!' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: 'Hello' },
      { type: 'text-delta', delta: ', world!' },
    ]);
    await expect(finalResult).resolves.toBe('Hello, world!');
  });

  it('a ping chunk resets the idle clock, preventing a timeout that would otherwise fire', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              if (step === 1 || step === 2) {
                // Two keep-alive pings, each arriving just under the idle
                // window, spanning a total gap that would otherwise have
                // exceeded it.
                step++;
                await new Promise((resolve) => setTimeout(resolve, 8));
                return { done: false, value: { type: 'ping' } };
              }
              await new Promise((resolve) => setTimeout(resolve, 8));
              return { done: true, value: undefined };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', chunkIdleTimeoutMs: 20 });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).resolves.toBe('first');
  });
});

describe('VernLLM streaming: readerStallTimeoutMs', () => {
  function manyChunks(count: number): WireStreamChunk[] {
    return Array.from({ length: count }, () => ({ type: 'text-delta' as const, delta: 'x' }));
  }

  it('detaches a reader that stops pulling, so finalResult still settles', async () => {
    const { client } = createMockStreamingClient([manyChunks(10_050)]);
    const llm = new VernLLM({
      client,
      model: 'm',
      logger: 'silent',
      readerStallTimeoutMs: 20,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'u',
      stream: true,
      jsonMode: false,
    });
    const iterator = chunks[Symbol.asyncIterator]();
    await iterator.next();

    await expect(finalResult).resolves.toHaveLength(10_050);
    await expect(iterator.next()).rejects.toMatchObject({
      type: 'timeout',
      code: 'reader_stall_timeout',
    });
  });

  it('keeps holding the stream for a stalled reader when left unset', async () => {
    const { client } = createMockStreamingClient([manyChunks(10_050)]);
    const llm = new VernLLM({ client, model: 'm', logger: 'silent' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'u',
      stream: true,
      jsonMode: false,
    });
    const iterator = chunks[Symbol.asyncIterator]();
    await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await isPending(finalResult)).toBe(true);

    let read = 1;
    while (!(await iterator.next()).done) read++;
    expect(read).toBe(10_050);
    await expect(finalResult).resolves.toHaveLength(10_050);
  });
});
