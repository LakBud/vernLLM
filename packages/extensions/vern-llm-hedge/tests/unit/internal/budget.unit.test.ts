import { describe, expect, it } from 'vitest';

import { HedgeBudget } from '../../../src/internal/budget.js';

describe('HedgeBudget', () => {
  it('starts empty, so a cold start never hedges', () => {
    expect(new HedgeBudget(0.5, 10).take()).toBe(false);
  });

  it('gives one token for every 1 / ratio eligible calls', () => {
    const budget = new HedgeBudget(0.25, 10);

    for (let call = 0; call < 3; call++) {
      budget.add();
      expect(budget.take()).toBe(false);
    }
    budget.add();

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it('absorbs float error, so twenty calls at 0.05 make a whole token', () => {
    const budget = new HedgeBudget(0.05, 10);

    for (let call = 0; call < 20; call++) budget.add();

    expect(budget.take()).toBe(true);
  });

  it('holds at most `burst` tokens', () => {
    const budget = new HedgeBudget(1, 2);

    for (let call = 0; call < 5; call++) budget.add();

    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
  });

  it('takes a refunded token back, but never holds more than `burst`', () => {
    const budget = new HedgeBudget(1, 1);
    budget.add();
    expect(budget.take()).toBe(true);

    budget.refund();
    budget.refund();

    expect([budget.take(), budget.take()]).toEqual([true, false]);
  });

  it('keeps hedges near `ratio` of calls when every call is slow', () => {
    const budget = new HedgeBudget(0.05, 10);
    let hedges = 0;

    for (let call = 0; call < 1_000; call++) {
      budget.add();
      if (budget.take()) hedges++;
    }

    expect(hedges).toBeGreaterThanOrEqual(49);
    expect(hedges).toBeLessThanOrEqual(50);
  });

  it('refills from calls that did not need a hedge', () => {
    const budget = new HedgeBudget(0.25, 10);

    for (let call = 0; call < 4; call++) budget.add();

    expect(budget.take()).toBe(true);
  });
});
