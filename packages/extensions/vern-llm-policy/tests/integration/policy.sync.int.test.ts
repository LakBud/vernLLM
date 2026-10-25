import { describe, expect, it, vi } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { fakeContext, request } from '../helpers.js';

import type { CallResult } from 'vern-llm';

/** `wrap` straight from the middleware, since a real `VernLLM` hides what happens before `next`. */
function wrapOf(options: Parameters<typeof policyMiddleware>[0]) {
  const { wrap } = policyMiddleware({ logger: 'silent', ...options });
  return wrap!;
}

const answered = async (): Promise<CallResult> => ({ value: 'ok' });

describe('wrap', () => {
  it('calls next before it yields, so nothing can interleave with the decision', () => {
    const wrap = wrapOf({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });
    const next = vi.fn(answered);

    const pending = wrap(request, next, fakeContext());

    // No `await` yet: the call to `next` already happened, in the same synchronous run.
    expect(next).toHaveBeenCalledTimes(1);
    return pending;
  });

  it('asks for the narrowed targets, in the incoming order', async () => {
    const wrap = wrapOf({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });
    const next = vi.fn(answered);

    await wrap(request, next, fakeContext({ targetNames: ['c', 'b', 'primary'] }));

    expect(next).toHaveBeenCalledWith({ targets: ['c', 'primary'] });
  });

  it('calls next with nothing when no target was removed, so the order is untouched', async () => {
    const wrap = wrapOf({ rules: [{ id: 'no-x', forbid: { name: 'x' } }] });
    const next = vi.fn(answered);

    await wrap(request, next, fakeContext());

    expect(next).toHaveBeenCalledWith();
  });

  it('returns what next returned, untouched', async () => {
    const wrap = wrapOf({});
    const result: CallResult = { value: { nested: true } };

    expect(await wrap(request, async () => result, fakeContext())).toBe(result);
  });

  it('rejects a denial without calling next, and without throwing synchronously', async () => {
    const wrap = wrapOf({ rules: [{ id: 'lockout', forbid: 'all' }] });
    const next = vi.fn(answered);

    const pending = wrap(request, next, fakeContext());

    expect(next).not.toHaveBeenCalled();
    await expect(pending).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('passes on whatever next rejects with', async () => {
    const wrap = wrapOf({});
    const failure = new Error('provider down');

    await expect(wrap(request, () => Promise.reject(failure), fakeContext())).rejects.toBe(failure);
  });
});
