import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, type RouterOptions } from '../../src/index.js';
import { rateLimitError, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const request = {
  model: 'm',
  max_tokens: 100,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

function setup(router: RouterOptions = {}) {
  const chain = targetChain();
  const holder: { llm?: VernLLM } = {};
  const middleware = routerMiddleware({
    logger: 'silent',
    health: () => holder.llm as never,
    ...router,
  });
  const llm = new VernLLM({ ...chain.options, middleware: [middleware] });
  holder.llm = llm;
  return { llm, chain, router: middleware };
}

describe('router.preview', () => {
  it('returns the order a real call then takes, without calling anything', async () => {
    const { llm, chain, router } = setup({
      routes: [{ name: 'fast', when: { hasTools: false }, targets: ['c', 'b'] }, { name: 'rest' }],
    });

    const decision = router.preview({ request });
    expect(chain.tried()).toEqual([]);
    expect(decision).toMatchObject({ route: 'fast', strategy: 'ordered', order: ['c', 'b'] });

    await llm.call(call);
    expect(chain.tried()).toEqual(['c']);
  });

  it('matches on context, a forced route and streaming like a call would', () => {
    const { router } = setup({
      routes: [
        { name: 'vip', when: { context: { tier: 'vip' } }, targets: ['b'] },
        { name: 'other', targets: ['c'] },
      ],
    });

    expect(router.preview({ request, context: { tier: 'vip' } }).route).toBe('vip');
    expect(router.preview({ request, context: { tier: 'free' } }).route).toBe('other');
    expect(router.preview({ request, route: 'vip' }).route).toBe('vip');
  });

  it('answers pinned for the call targets', () => {
    const { router } = setup({ routes: [{ name: 'all' }] });

    expect(router.preview({ request, targets: ['b', 'c'] })).toMatchObject({
      strategy: 'pinned',
      order: ['b', 'c'],
    });
  });

  it('sees live health: a rate limited target is demoted', async () => {
    const chain = targetChain({ primary: [rateLimitError()] });
    const holder: { llm?: VernLLM } = {};
    const router = routerMiddleware({
      logger: 'silent',
      health: () => holder.llm as never,
      routes: [{ name: 'all' }],
    });
    const llm = new VernLLM({ ...chain.options, middleware: [router] });
    holder.llm = llm;

    await llm.call(call);

    expect(router.preview({ request }).demoted).toEqual([{ target: 'primary', reason: 'limited' }]);
  });

  it('applies a deadline to over_deadline limits', () => {
    const { router } = setup({ routes: [{ name: 'all' }] });

    expect(router.preview({ request, deadlineMs: 5000 }).order).toEqual(['primary', 'b', 'c']);
  });

  it('throws without health, and for an unknown target', () => {
    expect(() => routerMiddleware({ logger: 'silent' }).preview({ request })).toThrow(
      /needs the health option/,
    );
    expect(() =>
      routerMiddleware({ logger: 'silent', health: () => undefined }).preview({ request }),
    ).toThrow(/return the VernLLM instance/);
    expect(() => setup().router.preview({ request, targets: ['nope'] })).toThrow(
      /names no target "nope"/,
    );
  });
});
