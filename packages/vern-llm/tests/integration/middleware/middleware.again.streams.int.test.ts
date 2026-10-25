import { describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { CALL, streamClient } from './middleware.int.helpers.js';

import type { CallMeta, VernLLMMiddleware } from '../../../src/types/index.js';

describe('next.again() with streams', () => {
  it('keeps the chain that reaches content first, and closes the other stream', async () => {
    const never = new Promise<void>(() => {});
    const { client, signals } = streamClient([{ text: 'slow', gate: never }, { text: 'fast' }]);
    const raceStreams: VernLLMMiddleware = {
      name: 'race-streams',
      reruns: true,
      wrap: async (_request, next) => Promise.any([next(), next.again!()]),
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [raceStreams] });
    const { finalResult } = await llm.call({ ...CALL, stream: true });

    await expect(finalResult).resolves.toBe('fast');

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('cancels every chain when the caller leaves chunks early', async () => {
    const { client, signals } = streamClient([
      { text: 'a', hold: true },
      { text: 'b', hold: true },
    ]);
    const both: VernLLMMiddleware = {
      name: 'both',
      reruns: true,
      wrap: async (_request, next) => {
        const [first] = await Promise.all([next(), next.again!()]);
        return first;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [both] });
    const { chunks } = await llm.call({ ...CALL, stream: true });

    for await (const _chunk of chunks) break;

    await vi.waitFor(() => {
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
  });

  it("holds the kept rerun's meta, with its chain, once its stream settles", async () => {
    const { client } = streamClient([{ text: 'first' }, { text: 'second' }]);
    const sequential: VernLLMMiddleware = {
      name: 'sequential',
      reruns: true,
      wrap: async (_request, next) => {
        await next();

        return next.again!();
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [sequential] });
    const meta: { current?: CallMeta } = {};
    const { finalResult } = await llm.call({ ...CALL, stream: true, meta });

    await expect(finalResult).resolves.toBe('second');

    expect(meta.current).toMatchObject({ provider: 'primary', chain: 1 });
  });
});

describe('streamClient', () => {
  const options = (signal: AbortSignal) => ({ signal });

  it('ends a gated stream at once when its signal is already aborted', async () => {
    const { client, signals } = streamClient([{ text: 'late', gate: new Promise<void>(() => {}) }]);
    const controller = new AbortController();
    controller.abort();

    const stream = client.chat.completions.createStream!(
      { model: 'm', messages: [], max_tokens: 1 },
      options(controller.signal),
    );

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(signals).toEqual([controller.signal]);
  });

  it('rejects a non streaming call, which no test scripts', async () => {
    const { client } = streamClient([{ text: 'x' }]);

    await expect(
      client.chat.completions.create(
        { model: 'm', messages: [], max_tokens: 1 },
        options(new AbortController().signal),
      ),
    ).rejects.toThrow('not scripted');
  });
});
