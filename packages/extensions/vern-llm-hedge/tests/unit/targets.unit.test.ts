import { describe, expect, it } from 'vitest';

import { nextTargets } from '../../src/index.js';

const ctxOf = (...names: string[]) => ({
  targets: names.map((name, index) => ({
    name,
    index,
    model: `${name}-model`,
    adapter: { name: 'custom' },
  })),
});

describe('nextTargets', () => {
  it('keeps the order without the first, so the hedge has its own fallback', () => {
    expect(nextTargets(ctxOf('a', 'b', 'c'))).toEqual(['b', 'c']);
  });

  it('is empty when there is only one target', () => {
    expect(nextTargets(ctxOf('a'))).toEqual([]);
  });
});

describe('recipes', () => {
  // The same code as the README's recipes, which are not exported.
  const sameTarget = (ctx: ReturnType<typeof ctxOf>) => [ctx.targets[0]!.name];

  const costs: Record<string, number | undefined> = { a: 1, b: 2, c: 3, d: undefined };
  const costFor = (target: { name: string }) => costs[target.name];
  const upToTwiceTheCost = (ctx: ReturnType<typeof ctxOf>) => {
    const first = costFor(ctx.targets[0]!) ?? Infinity;
    return nextTargets(ctx).filter((name) => {
      const target = ctx.targets.find((candidate) => candidate.name === name)!;
      return (costFor(target) ?? Infinity) <= 2 * first;
    });
  };

  it('sends a single provider setup back to the same target', () => {
    expect(sameTarget(ctxOf('only'))).toEqual(['only']);
  });

  it('drops targets that cost more than twice the first, and those with no known price', () => {
    expect(upToTwiceTheCost(ctxOf('a', 'b', 'c', 'd'))).toEqual(['b']);
  });
});
