import { describe, expect, it, vi } from 'vitest';

import { guardLabels, guardMiddleware, patterns } from '../../src/index.js';
import { captureLogger, fakeContext, request } from '../helpers.js';

import type { CallResult } from 'vern-llm';

const result: CallResult = { value: 'answer' };

/** A context that makes the guard fail on its own: its per call storage cannot be written. */
const broken = () => fakeContext({ own: Object.freeze({}) as Record<string, unknown> });

describe('a guard that breaks on its own, not one of its checks', () => {
  it('refuses the call by default, and still emits a record', async () => {
    const log = captureLogger();
    const guard = guardMiddleware({
      version: 'v1',
      logger: log.logger,
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    });
    const { ctx, emitted } = broken();
    const next = vi.fn(async () => result);

    const error = await guard.wrap!(request, next, ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({
      type: 'invalid_params',
      code: 'content_blocked',
      message: 'Call blocked by guard: the checks could not be run (input)',
      issues: { version: 'v1', phase: 'input', checks: [], labels: [], failed: true },
    });
    expect(next).not.toHaveBeenCalled();
    expect(log.errors()).toEqual(['[VernLLM] guard: input scan failed']);
    expect(emitted).toEqual([
      {
        name: 'guard.result',
        data: {
          v: 1,
          version: 'v1',
          outcome: 'blocked',
          input: {
            checks: {},
            audit: {},
            errors: [{ name: 'TypeError' }],
            late: 0,
            unscanned: 0,
          },
        },
      },
    ]);
    expect(guardLabels(ctx)).toBeUndefined();
  });

  it('runs the call unguarded when set to fail open, with the labels unknown', async () => {
    const log = captureLogger();
    const guard = guardMiddleware({
      version: 'v1',
      onError: 'open',
      logger: log.logger,
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    });
    const { ctx, emitted } = broken();
    const next = vi.fn(async () => result);

    await expect(guard.wrap!(request, next, ctx)).resolves.toBe(result);

    expect(next).toHaveBeenCalledTimes(1);
    expect(guardLabels(ctx)).toBeUndefined();
    expect(log.errors()).toEqual(['[VernLLM] guard: input scan failed']);
    expect(emitted).toEqual([]);
  });
});

describe('labels', () => {
  it('are frozen, so a reader cannot change what policy sees', async () => {
    const guard = guardMiddleware({
      version: 'v1',
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    });
    const { ctx } = fakeContext();

    await guard.wrap!(
      { ...request, messages: [{ role: 'user', content: 'jane@acme.com' }] },
      async () => result,
      ctx,
    );

    expect(guardLabels(ctx)).toEqual(['pii']);
    expect(Object.isFrozen(guardLabels(ctx))).toBe(true);
  });
});

/** A context whose clock fails after `okReads` reads, so the n-th scan of a call breaks. */
function flaky(okReads: number) {
  const made = fakeContext({
    transformMiddlewareNames: ['guard'],
  } as never);
  let reads = 0;
  Object.defineProperty(made.ctx, 'deadlineAt', {
    get: () => {
      if (++reads > okReads) throw new Error('clock');
      return undefined;
    },
  });
  return made;
}

describe('a later scan of the same call breaking', () => {
  const parallel = {
    id: 'j',
    detect: () => [],
    action: 'block' as const,
    parallel: true,
  };

  it('refuses the call when the checks alongside it cannot start, and the guard fails closed', async () => {
    const guard = guardMiddleware({ version: 'v1', logger: 'silent', checks: [parallel] });
    const { ctx, emitted } = flaky(1);
    const next = vi.fn(async () => result);

    const error = await guard.wrap!(request, next, ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'content_blocked', issues: { failed: true } });
    expect(next).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });

  it('lets the call go on when it fails open, and reports the error', async () => {
    const guard = guardMiddleware({
      version: 'v1',
      logger: 'silent',
      onError: 'open',
      checks: [parallel],
    });
    const { ctx, emitted } = flaky(1);

    await expect(guard.wrap!(request, async () => result, ctx)).resolves.toBe(result);

    expect(emitted[0]!.data).toMatchObject({
      outcome: 'passed',
      input: { errors: [{ name: 'Error' }] },
    });
  });

  it.each([
    ['refuses the call', 'closed', 'content_blocked'],
    ['lets the call run', 'open', undefined],
  ] as const)('when a transform cannot scan, %s on %s', async (_name, onError, code) => {
    const guard = guardMiddleware({
      version: 'v1',
      logger: 'silent',
      onError,
      checks: [{ id: 'pii', detect: patterns(['email']), action: 'redact' }],
    });
    const { ctx } = flaky(1);

    const outcome = await guard.wrap!(
      request,
      async () => ({ value: await guard.transform!(request, ctx as never) }),
      ctx,
    )
      .then((done) => done.value)
      .catch((e: unknown) => e);

    if (code === undefined) expect(outcome).toEqual({});
    else expect(outcome).toMatchObject({ code });
  });

  it('runs a call unguarded when wrap never made a state for it', async () => {
    const guard = guardMiddleware({
      version: 'v1',
      logger: 'silent',
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    });
    const { ctx } = fakeContext({ transformMiddlewareNames: ['guard'] } as never);
    await expect(guard.transform!(request, ctx as never)).resolves.toEqual({});
  });
});

describe('a mask that throws', () => {
  it('hides the whole text in redactText instead of failing', () => {
    const guard = guardMiddleware({
      version: 'v1',
      logger: 'silent',
      checks: [{ id: 'pii', detect: patterns(['email']), action: 'redact' }],
      mask: () => {
        throw new Error('mask');
      },
    });
    expect(guard.redactText('mail jane@acme.com')).toBe('[REDACTED]');
  });

  it('fails open on an answer it cannot read, even one with a hostile shape', async () => {
    const guard = guardMiddleware({
      version: 'v1',
      logger: 'silent',
      onError: 'open',
      checks: [{ id: 'k', detect: () => [], action: 'block', on: 'output' }],
    });
    const { ctx } = fakeContext();
    const hostile = {
      get type(): string {
        throw new Error('getter');
      },
    };

    const answer = await guard.wrap!(request, async () => ({ value: hostile }), ctx);

    expect(answer.value).toBe(hostile);
  });
});
