import { VernLLM, type Logger } from 'vern-llm';
import { describe, expect, vi } from 'vitest';

import { callContext, sleep, trip } from '../../breakerHelpers.js';
import { it } from '../../fixtures.js';
import { uniquePrefix, waitUntil } from '../../helpers.js';

/** Just enough of an LLM client for VernLLM to run one call. */
const okClient = () =>
  ({
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      },
    },
  }) as never;

describe.concurrent('redisCircuitBreaker prepare and readState, real Redis', () => {
  it('a process that has never touched the key learns it is open on its very first call', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const a = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 });
    const b = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 });
    await trip(a);

    // Without prepare, b treats an unseen key as closed and lets this through.
    await b.prepare?.('m');

    expect(() => b.assertClosed('m')).toThrowError(/open/);
  });

  it('the first call after a cooldown is admitted as the trial, not rejected', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 250 });
    await trip(breaker);
    await sleep(350);

    await breaker.prepare?.('m');
    const call = callContext();

    expect(() => breaker.assertClosed('m', call)).not.toThrow();
    breaker.recordSuccess('m', call);
    await waitUntil(() => breaker.getState?.('m') === 'closed');
  });

  it('an open circuit is left alone until its cooldown is over, judged from the Redis clock', async ({
    redis,
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 500 });
    await trip(breaker);
    const evalSpy = vi.spyOn(redis, 'eval');

    // A burst while the cooldown is running costs no Redis round trips at all.
    await Promise.all(Array.from({ length: 50 }, () => breaker.prepare?.('m')));
    expect(evalSpy).not.toHaveBeenCalled();

    await sleep(600);
    await breaker.prepare?.('m');
    expect(evalSpy).toHaveBeenCalledTimes(1);
  });

  it('readState reports the live state, and a key that was never written as closed', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const a = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 });
    const b = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 });

    expect(await b.readState?.('m')).toBe('closed');
    await trip(a);
    expect(await b.readState?.('m')).toBe('open');
    expect(b.getState?.('m')).toBe('open'); // and the local copy followed

    a.close?.('m');
    await waitUntil(async () => (await b.readState?.('m')) === 'closed');
  });

  describe('through VernLLM', () => {
    it('a fresh process rejects on its first call when another process tripped the circuit', async ({
      makeBreaker,
    }) => {
      const prefix = uniquePrefix('cb');
      const a = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 });
      await trip(a);

      const llm = new VernLLM({
        client: okClient(),
        model: 'm',
        maxRetries: 0,
        circuitBreaker: makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 }),
      });

      await expect(llm.call({ userContent: 'hi' })).rejects.toMatchObject({ type: 'circuit_open' });
    });

    it('the first call after the cooldown succeeds and closes the circuit', async ({
      makeBreaker,
    }) => {
      const prefix = uniquePrefix('cb');
      const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 250 });
      await trip(breaker);
      await sleep(350);

      const llm = new VernLLM({
        client: okClient(),
        model: 'm',
        maxRetries: 0,
        circuitBreaker: breaker,
      });

      await expect(llm.call({ userContent: 'hi' })).resolves.toEqual({ ok: true });
      await waitUntil(async () => (await llm.readCircuitStates())[0]?.state === 'closed');
    });

    it('readCircuitStates returns the live state from Redis', async ({ makeBreaker }) => {
      const prefix = uniquePrefix('cb');
      const a = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 30_000 });
      await trip(a);
      const llm = new VernLLM({
        client: okClient(),
        model: 'm',
        circuitBreaker: makeBreaker({
          keyPrefix: prefix,
          isolateByModel: true,
          cooldownMs: 30_000,
        }),
      });

      // Isolated per model, so this process has nothing for it yet, and asks Redis.
      expect((await llm.readCircuitStates())[0]?.state).toBe('closed');
    });

    it('a hung Redis costs a call at most the timeout, then it goes through', async ({
      redis,
      makeBreaker,
    }) => {
      const prefix = uniquePrefix('cb');
      const warn = vi.fn();
      const logger: Logger = { debug: vi.fn(), warn, error: vi.fn() };
      const breaker = makeBreaker({ keyPrefix: prefix, prepareTimeoutMs: 100 });
      vi.spyOn(redis, 'eval').mockImplementation(() => new Promise(() => {}));
      const llm = new VernLLM({ client: okClient(), model: 'm', logger, circuitBreaker: breaker });

      const started = Date.now();
      await expect(llm.call({ userContent: 'hi' })).resolves.toEqual({ ok: true });

      expect(Date.now() - started).toBeLessThan(1500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('longer than 100ms'));
    });

    it('Redis failing outright is a warning, not a failed call', async ({ redis, makeBreaker }) => {
      const warn = vi.fn();
      const logger: Logger = { debug: vi.fn(), warn, error: vi.fn() };
      const breaker = makeBreaker({ keyPrefix: uniquePrefix('cb') });
      vi.spyOn(redis, 'eval').mockRejectedValue(new Error('Redis is down'));
      const llm = new VernLLM({ client: okClient(), model: 'm', logger, circuitBreaker: breaker });

      await expect(llm.call({ userContent: 'hi' })).resolves.toEqual({ ok: true });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Redis is down'));
    });
  });
});

/** Asserts on elapsed time, so it runs on its own rather than next to other tests. */
describe('redisCircuitBreaker prepare with a slow Redis', () => {
  it('a hung Redis delays the first calls by the timeout, and later ones not at all', async ({
    redis,
    makeBreaker,
  }) => {
    const breaker = makeBreaker({ keyPrefix: uniquePrefix('cb'), prepareTimeoutMs: 100 });
    vi.spyOn(redis, 'eval').mockImplementation(() => new Promise(() => {}));
    const llm = new VernLLM({
      client: okClient(),
      model: 'm',
      logger: 'silent',
      circuitBreaker: breaker,
    });

    await llm.call({ userContent: 'first' }); // pays the timeout
    const started = Date.now();
    for (let i = 0; i < 20; i++) await llm.call({ userContent: `later ${i}` });

    expect(Date.now() - started).toBeLessThan(400);
  });
});
