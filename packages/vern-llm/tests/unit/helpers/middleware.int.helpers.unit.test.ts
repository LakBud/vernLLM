import { describe, expect, expectTypeOf, it } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, textResponse } from '../../helpers.js';
import {
  CALL,
  fallbackChain,
  metaRecorder,
  targetChain,
  USAGE,
  withUsage,
  wrapCounter,
} from '../../integration/middleware/middleware.int.helpers.js';
import { baseRequest } from '../internal/execution/utils/middleware/middleware.helpers.js';

import type { CallMeta, CallResult, PreDispatchContext } from '../../../src/types/index.js';

/**
 * Exercises `middleware.int.helpers.ts` itself, the shared building blocks the
 * middleware integration tests stand on. A wrong helper would make those tests pass for the
 * wrong reason, so each one is checked here directly, both on its own and against a real
 * `VernLLM` call where that is the whole point of the helper.
 */

// The helpers' `wrap` hooks never read `ctx`.
const ctx = {} as PreDispatchContext;

const meta: CallMeta = {
  provider: 'primary',
  model: 'test-model',
  fallbackIndex: -1,
  usedFallback: false,
  attempts: 1,
  position: 0,
};

describe('CALL', () => {
  it('is the plain text call most middleware tests make', () => {
    expect(CALL).toEqual({ userContent: 'hi', jsonMode: false });
  });

  it('keeps jsonMode as the literal false, which is what makes call() return a string', async () => {
    expectTypeOf<typeof CALL>().toEqualTypeOf<{ userContent: string; jsonMode: false }>();

    const { client } = createMockClient([textResponse('plain text, not JSON')]);
    const result = await new VernLLM({ client, model: 'test-model' }).call(CALL);

    expectTypeOf(result).toBeString();
    expect(result).toBe('plain text, not JSON');
  });
});

describe('USAGE', () => {
  it('reports 10 prompt and 5 completion tokens', () => {
    expect(USAGE).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it('has a total that is the sum of the two, as a provider would report it', () => {
    expect(USAGE.total_tokens).toBe(USAGE.prompt_tokens + USAGE.completion_tokens);
    expect(USAGE.total_tokens).toBe(15);
  });
});

describe('withUsage', () => {
  it('is a text response that also carries USAGE', () => {
    expect(withUsage('ok')).toEqual({ ...textResponse('ok'), usage: USAGE });
  });

  it('makes a real call report usage, so a usage event fires', async () => {
    const { client } = createMockClient([withUsage('ok')]);
    const usages: unknown[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      onUsage: (usage) => void usages.push(usage),
    });

    await expect(llm.call(CALL)).resolves.toBe('ok');

    expect(usages).toEqual([
      expect.objectContaining({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
    ]);
  });
});

describe('wrapCounter', () => {
  it('starts at zero and is named counter', () => {
    const counter = wrapCounter();

    expect(counter.count()).toBe(0);
    expect(counter.middleware.name).toBe('counter');
  });

  it('counts every wrap and hands back exactly what next() resolved with', async () => {
    const counter = wrapCounter();
    const result: CallResult = { value: 'answer', meta };

    const first = await counter.middleware.wrap!(baseRequest, async () => result, ctx);
    expect(counter.count()).toBe(1);

    const second = await counter.middleware.wrap!(baseRequest, async () => result, ctx);
    expect(counter.count()).toBe(2);

    expect(first).toBe(result);
    expect(second).toBe(result);
  });

  it('counts a wrap whose next() rejects, and lets the rejection through', async () => {
    const counter = wrapCounter();
    const failure = new Error('provider down');

    await expect(
      counter.middleware.wrap!(baseRequest, () => Promise.reject(failure), ctx),
    ).rejects.toBe(failure);

    expect(counter.count()).toBe(1);
  });

  it('counts before next() runs, so next() can see its own wrap already counted', async () => {
    const counter = wrapCounter();
    let seenInsideNext: number | undefined;

    await counter.middleware.wrap!(
      baseRequest,
      async () => {
        seenInsideNext = counter.count();
        return { value: 'x' };
      },
      ctx,
    );

    expect(seenInsideNext).toBe(1);
  });

  it('takes a custom name', () => {
    expect(wrapCounter('cache-counter').middleware.name).toBe('cache-counter');
  });

  it('keeps separate counters independent', async () => {
    const a = wrapCounter();
    const b = wrapCounter();

    await a.middleware.wrap!(baseRequest, async () => ({ value: 1 }), ctx);
    await a.middleware.wrap!(baseRequest, async () => ({ value: 1 }), ctx);

    expect(a.count()).toBe(2);
    expect(b.count()).toBe(0);
  });

  it('counts once per logical call in a real VernLLM, however many attempts ran', async () => {
    const { client } = createMockClient([new FakeApiError('temporary', 500), textResponse('ok')]);
    const counter = wrapCounter();

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      middleware: [counter.middleware],
    });

    await expect(llm.call(CALL)).resolves.toBe('ok');

    expect(counter.count()).toBe(1);
  });
});

describe('metaRecorder', () => {
  it('has recorded nothing before any call, and is named meta-recorder', () => {
    const recorder = metaRecorder();

    expect(recorder.meta()).toBeUndefined();
    expect(recorder.middleware.name).toBe('meta-recorder');
  });

  it('records the meta next() resolves with, and hands back the result untouched', async () => {
    const recorder = metaRecorder();
    const result: CallResult = { value: 'answer', meta };

    const returned = await recorder.middleware.wrap!(baseRequest, async () => result, ctx);

    expect(recorder.meta()).toBe(meta);
    expect(returned).toBe(result);
  });

  it('keeps the latest meta, including an absent one from a call that had none', async () => {
    const recorder = metaRecorder();

    await recorder.middleware.wrap!(baseRequest, async () => ({ value: 'a', meta }), ctx);
    expect(recorder.meta()).toBe(meta);

    await recorder.middleware.wrap!(baseRequest, async () => ({ value: 'b' }), ctx);
    expect(recorder.meta()).toBeUndefined();
  });

  it('records nothing when next() rejects, keeps what it had, and lets the rejection through', async () => {
    const recorder = metaRecorder();
    const failure = new Error('provider down');

    await recorder.middleware.wrap!(baseRequest, async () => ({ value: 'a', meta }), ctx);
    await expect(
      recorder.middleware.wrap!(baseRequest, () => Promise.reject(failure), ctx),
    ).rejects.toBe(failure);

    expect(recorder.meta()).toBe(meta);
  });

  it('takes a custom name', () => {
    expect(metaRecorder('stream-meta').middleware.name).toBe('stream-meta');
  });

  it('records the real meta of a VernLLM call', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const recorder = metaRecorder();

    const llm = new VernLLM({
      client,
      model: 'test-model',
      name: 'test-provider',
      middleware: [recorder.middleware],
    });

    await llm.call(CALL);

    expect(recorder.meta()).toEqual({
      provider: 'test-provider',
      model: 'test-model',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
      position: 0,
    });
  });
});

describe('fallbackChain', () => {
  it('wires a primary and one fallback into options a test can spread into new VernLLM', () => {
    const chain = fallbackChain([textResponse('p')], [textResponse('f')]);

    expect(chain.options.client).toBe(chain.primary.client);
    expect(chain.options).toMatchObject({
      model: 'primary-model',
      name: 'primary',
      maxRetries: 0,
      logger: 'silent',
    });
    expect(chain.options.fallback).toEqual({
      client: chain.fallback.client,
      model: 'fallback-model',
      name: 'fallback',
    });
  });

  it('gives each target its own script and its own call log', async () => {
    const chain = fallbackChain([textResponse('from primary')], [textResponse('from fallback')]);
    const params = { model: 'm', max_tokens: 10, messages: [] };
    const options = { signal: new AbortController().signal };

    const primary = await chain.primary.client.chat.completions.create(params, options);
    const fallback = await chain.fallback.client.chat.completions.create(params, options);

    expect(primary.choices?.[0]?.message?.content).toBe('from primary');
    expect(fallback.choices?.[0]?.message?.content).toBe('from fallback');
    expect(chain.primary.calls).toHaveLength(1);
    expect(chain.fallback.calls).toHaveLength(1);
    expect(chain.primary.client).not.toBe(chain.fallback.client);
  });

  it('runs a real chain with retries off: a failing primary is tried once, then the fallback answers', async () => {
    const chain = fallbackChain([new FakeApiError('primary down', 500)], [textResponse('rescued')]);

    const llm = new VernLLM(chain.options);

    await expect(llm.call(CALL)).resolves.toBe('rescued');

    expect(chain.primary.create).toHaveBeenCalledTimes(1);
    expect(chain.fallback.create).toHaveBeenCalledTimes(1);
  });

  it('lets a test add to the spread options, such as a middleware', async () => {
    const chain = fallbackChain([new FakeApiError('primary down', 500)], [textResponse('rescued')]);
    const counter = wrapCounter();

    const llm = new VernLLM({ ...chain.options, middleware: [counter.middleware] });

    await expect(llm.call(CALL)).resolves.toBe('rescued');

    expect(counter.count()).toBe(1);
  });
});

describe('targetChain', () => {
  it('wires three named targets into options a test can spread into new VernLLM', () => {
    const chain = targetChain([textResponse('p')], [textResponse('b')], [textResponse('c')]);

    expect(chain.options.client).toBe(chain.primary.client);
    expect(chain.options).toMatchObject({
      model: 'primary-model',
      name: 'primary',
      maxRetries: 0,
      logger: 'silent',
    });
    expect(chain.options.fallback).toEqual([
      { client: chain.b.client, model: 'b-model', name: 'b' },
      { client: chain.c.client, model: 'c-model', name: 'c' },
    ]);
  });

  it('gives each target its own script and its own call log', async () => {
    const chain = targetChain(
      [textResponse('from p')],
      [textResponse('from b')],
      [textResponse('from c')],
    );
    const params = { model: 'm', max_tokens: 10, messages: [] };
    const options = { signal: new AbortController().signal };

    const [p, b, c] = await Promise.all(
      [chain.primary, chain.b, chain.c].map((target) =>
        target.client.chat.completions.create(params, options),
      ),
    );

    expect([p, b, c].map((response) => response?.choices?.[0]?.message?.content)).toEqual([
      'from p',
      'from b',
      'from c',
    ]);
    expect([chain.primary, chain.b, chain.c].map((target) => target.calls.length)).toEqual([
      1, 1, 1,
    ]);
    expect(new Set([chain.primary.client, chain.b.client, chain.c.client]).size).toBe(3);
  });

  it('runs a real chain with retries off, trying each declared target once in order', async () => {
    const chain = targetChain(
      [new FakeApiError('primary down', 500)],
      [new FakeApiError('b down', 500)],
      [textResponse('rescued by c')],
    );

    const llm = new VernLLM(chain.options);

    await expect(llm.call(CALL)).resolves.toBe('rescued by c');

    expect(chain.primary.create).toHaveBeenCalledTimes(1);
    expect(chain.b.create).toHaveBeenCalledTimes(1);
    expect(chain.c.create).toHaveBeenCalledTimes(1);
  });
});
