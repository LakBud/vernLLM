import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../src/index.js';
import { eventProbe, heldClient, settle, targetChain, waitFor } from '../helpers.js';

const ask = (userContent: string) => ({ userContent, jsonMode: false as const });
const prompt = 'You are a careful assistant. '.repeat(10);

function setup(options: HedgeOptions) {
  const primary = heldClient('primary');
  const chain = targetChain({ primary: primary.client });
  const probe = eventProbe('hedge.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      hedgeMiddleware({ delay: 20, budget: { ratio: 1, burst: 4 }, logger: 'silent', ...options }),
    ],
  });

  /** A call the first target answers after `waitMs`, reporting `cachedTokens` read from its cache. */
  async function answered(userContent: string, cachedTokens: number | undefined, waitMs = 0) {
    const index = primary.requests.length;
    const pending = llm.call(ask(userContent));
    await waitFor(() => primary.requests.length === index + 1);
    await settle(waitMs);
    primary.requests[index]!.answer('primary', 500, cachedTokens);
    await pending;
  }

  return { answered, chain, last: () => probe.events.at(-1) as Record<string, unknown> };
}

describe('a first target with the prompt in its cache', () => {
  it('is waited for longer before a hedge goes out', async () => {
    const { answered, chain, last } = setup({ delay: 100, cacheAware: { prefixChars: 100 } });
    await answered(prompt, 400);

    // Past the plain delay of 100 ms and inside the doubled one: not hedged.
    await answered(`${prompt} A new question.`, 400, 150);

    expect(last()).toMatchObject({ outcome: 'not_needed', delayMs: 200 });
    expect(chain.tried()).toEqual(['primary', 'primary']);
  });

  it('is not hedged at all when asked to skip', async () => {
    const { answered, chain, last } = setup({ cacheAware: { action: 'skip', prefixChars: 100 } });
    await answered(prompt, 400);

    await answered(`${prompt} A new question.`, 400, 40);

    expect(last()).toEqual({ v: 1, outcome: 'cached' });
    expect(chain.tried()).toEqual(['primary', 'primary']);
  });

  it('is hedged as usual for a prompt it has not served from its cache', async () => {
    const { answered, last } = setup({ cacheAware: true });
    await answered(prompt, 400);

    await answered('A completely different prompt.', undefined);

    expect(last()).toMatchObject({ outcome: 'not_needed', delayMs: 20 });
  });

  it('is hedged as usual when its answer to the prompt did not come from the cache', async () => {
    const { answered, last } = setup({ cacheAware: true });
    await answered(prompt, 0);

    await answered(prompt, undefined);

    expect(last()).toMatchObject({ delayMs: 20 });
  });

  it('is hedged as usual once the cache would have expired', async () => {
    const { answered, last } = setup({ cacheAware: { ttlMs: 30, prefixChars: 100 } });
    await answered(prompt, 400);
    await settle(80);

    await answered(prompt, undefined);

    expect(last()).toMatchObject({ delayMs: 20 });
  });

  it('is hedged as usual when cache awareness is not asked for', async () => {
    const { answered, last } = setup({});
    await answered(prompt, 400);

    await answered(prompt, undefined);

    expect(last()).toMatchObject({ delayMs: 20 });
  });
});
