import { describe, expect, it, vi } from 'vitest';

import { joinParallel, startParallel } from '../../../../src/internal/middleware/parallel.utils.js';
import { compile } from '../../../../src/internal/options/compile.utils.js';

import type { Check, PhaseReport } from '../../../../src/index.js';
import type { Memo } from '../../../../src/internal/scan/types.js';
import type { PreDispatchContext } from 'vern-llm';

const ctx = { context: undefined, streaming: false } as unknown as PreDispatchContext;
const check: Check = { id: 'j', detect: () => [], action: 'block', parallel: true };
const report = (): PhaseReport => ({ checks: {}, audit: {}, errors: [], late: 0, unscanned: 0 });
const brokenMemo = {
  get: () => {
    throw new Error('memo down');
  },
  set: () => {},
  size: 0,
} as unknown as Memo;

describe('startParallel', () => {
  it('starts nothing without a parallel check', () => {
    const compiled = compile({ version: 'v', checks: [{ ...check, parallel: false }] });
    expect(
      startParallel(compiled, [], new Map(), undefined, ctx, new AbortController().signal),
    ).toBeUndefined();
  });

  it('turns a failure of the scan itself into an outcome', () => {
    const compiled = compile({ version: 'v', checks: [check] });
    const outcome = startParallel(
      compiled,
      [{ text: 'a', source: 'user' }],
      new Map(),
      brokenMemo,
      ctx,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ error: expect.any(Error) });
  });
});

describe('joinParallel', () => {
  it('blocks when the scan broke and the guard fails closed, and tells the caller', async () => {
    const compiled = compile({ version: 'v', checks: [check] });
    const onFailure = vi.fn();
    const input = report();

    const { refusal } = await joinParallel(
      { error: new RangeError('x') },
      compiled,
      input,
      onFailure,
    );

    expect(refusal).toMatchObject({ code: 'content_blocked' });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(input.errors).toEqual([{ name: 'RangeError' }]);
  });

  it('lets the call through when it fails open', async () => {
    const compiled = compile({ version: 'v', checks: [check], onError: 'open' });
    const { refusal } = await joinParallel({ error: new Error('x') }, compiled, report(), () => {});
    expect(refusal).toBeUndefined();
  });
});
