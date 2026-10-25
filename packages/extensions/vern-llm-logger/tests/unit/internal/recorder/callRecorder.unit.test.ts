import { LLMError, type AttemptContext, type PreDispatchContext } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { CallRecorder } from '../../../../src/internal/recorder/callRecorder.js';
import { talliesOf } from '../../../../src/internal/stats/attemptTally.utils.js';

import type { LoggerMiddlewareOptions } from '../../../../src/index.js';

// The attempt model driven directly, one signal at a time, for the orders and edge cases a real
// VernLLM rarely produces.

const preDispatch = (extra: Partial<PreDispatchContext> = {}) =>
  ({ requestId: 'req_1', context: undefined, ...extra }) as PreDispatchContext;
const attemptCtx = (provider = 'primary', model = 'gpt-4o', chain?: number) =>
  ({
    requestedProvider: provider,
    requestedModel: model,
    ...(chain === undefined ? {} : { chain }),
  }) as AttemptContext;

function recorder(options: LoggerMiddlewareOptions = {}, ctx = preDispatch()) {
  return CallRecorder.start(
    ctx,
    normalizeOptions({ logger: 'silent', ...options }),
    createGuard('silent'),
  );
}

const ok = { kind: 'result', result: { value: 'x' } } as const;
const failure = (error: unknown) => ({ kind: 'error', error }) as const;
const serverError = () => new LLMError('x', 'api', { status: 500, code: 'server_error' as never });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the attempt model', () => {
  it('counts an attempt once dispatch opens, and keeps it open after the response', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    vi.advanceTimersByTime(40);
    r.responded();
    vi.advanceTimersByTime(10);

    const record = r.finish(ok)!;

    expect(record.attempts).toBe(1);
    expect(record.path).toEqual([
      { provider: 'primary', model: 'gpt-4o', attempts: 1, outcome: 'ok', elapsedMs: 50 },
    ]);
  });

  it('measures the answering attempt to its response, not to the end of the call', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    vi.advanceTimersByTime(100);
    r.responded();
    // Parsing and validation after the response still belong to the call, not to the attempt.
    vi.advanceTimersByTime(900);
    r.setUsage(
      { promptTokens: 1, completionTokens: 50, totalTokens: 51, requestId: 'r', model: 'm' },
      false,
    );

    expect(r.finish(ok)!.outputTokensPerSec).toBe(500);
  });

  it('a retry closes the open attempt, whether or not dispatch resolved', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.responded();
    r.retried(25, serverError());
    r.openAttempt(attemptCtx());

    const record = r.finish(ok)!;

    expect(record).toMatchObject({ attempts: 2, retries: 1, retryDelayMs: 25 });
    expect(record.path).toHaveLength(1);
    expect(record.path[0]!.attempts).toBe(2);
  });

  it('a failed dispatch followed by a retry event is not counted twice', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(serverError());
    r.retried(5, serverError());
    r.openAttempt(attemptCtx());

    expect(r.finish(ok)).toMatchObject({ attempts: 2, retries: 1 });
  });

  it('a second open while one is still open counts both and does not guess the first outcome', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.openAttempt(attemptCtx());

    const record = r.finish(ok)!;

    expect(record.attempts).toBe(2);
    expect(record.path[0]!.attempts).toBe(2);
  });

  it('does not count an attempt that was rejected before anything was sent', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(
      new LLMError('no', 'invalid_params', { code: 'unsupported_capability' as never }),
    );

    const record = r.finish(failure(new LLMError('no', 'invalid_params')))!;

    expect(record.attempts).toBe(0);
    expect(record.path).toEqual([]);
  });

  it('keeps the target of a local rejection when it also made a real attempt', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(serverError());
    r.retried(1, serverError());
    r.openAttempt(attemptCtx());
    r.attemptFailed(new LLMError('no', 'invalid_params', { code: 'middleware_threw' as never }));

    const record = r.finish(failure(serverError()))!;

    expect(record.attempts).toBe(1);
    expect(record.path).toHaveLength(1);
    expect(record.path[0]!.attempts).toBe(1);
  });

  it('counts a real adapter failure', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(serverError());

    expect(r.finish(failure(serverError()))!.attempts).toBe(1);
  });

  it('ignores signals when no attempt is open', () => {
    const r = recorder();

    expect(() => {
      r.responded();
      r.attemptFailed(serverError());
    }).not.toThrow();
    expect(r.finish(ok)!.attempts).toBe(0);
  });
});

describe('the path', () => {
  it('opens one entry per target and closes the one it leaves with the core elapsed time', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o'));
    r.attemptFailed(serverError());
    r.fellBack(123, serverError());
    r.openAttempt(attemptCtx('fallback[0]', 'claude-x'));
    vi.advanceTimersByTime(30);

    const { path } = r.finish(ok)!;

    expect(path).toEqual([
      {
        provider: 'primary',
        model: 'gpt-4o',
        attempts: 1,
        outcome: 'error',
        elapsedMs: 123,
        errorCode: 'server_error',
      },
      { provider: 'fallback[0]', model: 'claude-x', attempts: 1, outcome: 'ok', elapsedMs: 30 },
    ]);
  });

  it('a target left by a fallback is not overwritten when the next target never dispatches', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary'));
    r.attemptFailed(serverError());
    r.fellBack(77, new LLMError('x', 'timeout', { code: 'attempt_timeout' as never }));
    vi.advanceTimersByTime(500);

    // The fallback target was skipped, for example by its own open circuit.
    const { path } = r.finish(failure(new LLMError('all down', 'circuit_open')))!;

    expect(path).toEqual([
      {
        provider: 'primary',
        model: 'gpt-4o',
        attempts: 1,
        outcome: 'error',
        elapsedMs: 77,
        errorCode: 'attempt_timeout',
      },
    ]);
  });

  it('measures a fallback whose elapsed time is missing or invalid', () => {
    for (const bad of [Number.NaN, -5]) {
      const r = recorder();
      r.openAttempt(attemptCtx());
      vi.advanceTimersByTime(40);
      r.fellBack(bad, serverError());

      expect(r.finish(failure(serverError()))!.path[0]!.elapsedMs).toBe(40);
    }
  });

  it("takes the last attempt's own reason from an exhausted fallback chain", () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    const exhausted = Object.assign(new LLMError('all failed', 'fallback_exhausted'), {
      attempts: [{ error: { type: 'api', code: 'server_error' } }],
    });

    const { path, error } = r.finish(failure(exhausted))!;

    expect(error).toEqual({ type: 'fallback_exhausted' });
    expect(path[0]).toMatchObject({ outcome: 'error', errorCode: 'server_error' });
  });

  it('ignores a fallback signal with no target to leave', () => {
    const r = recorder();
    expect(() => r.fellBack(10, serverError())).not.toThrow();
    expect(r.finish(ok)!.path).toEqual([]);
  });
});

describe('events', () => {
  it('adds up rate limit waits and ignores unusable ones', () => {
    const r = recorder();
    for (const waited of [30, 20, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) r.queued(waited);

    expect(r.finish(ok)!.queueWaitMs).toBe(50);
  });

  it('keeps the last usage and whether it came from a failure', () => {
    const r = recorder();
    const usage = (n: number) => ({
      promptTokens: n,
      completionTokens: 1,
      totalTokens: n + 1,
      requestId: 'r',
      model: 'm',
    });
    r.setUsage(usage(1), true);
    r.setUsage(usage(2), false);

    const record = r.finish(ok)!;

    expect(record.usage!.promptTokens).toBe(2);
    expect(record).not.toHaveProperty('usageFailed');
  });

  it('notes a short circuit and every middleware event', () => {
    const r = recorder();
    r.noteMiddleware({ kind: 'transform', name: 'a', patchedFields: ['temperature'] });
    r.noteMiddleware({ kind: 'wrap_short_circuit', name: 'guard' });

    const record = r.finish(ok)!;

    expect(record.shortCircuitedBy).toBe('guard');
    expect(record.middleware).toHaveLength(2);
  });

  it('collects custom events by name in order, with a missing payload as null', () => {
    const r = recorder();
    r.addCustom('usage.budget_warning', { share: 0.5 });
    r.addCustom('usage.budget_warning', { share: 0.9 });
    r.addCustom('router.decision', undefined);

    expect(r.finish(ok)!.custom).toEqual({
      'usage.budget_warning': [{ share: 0.5 }, { share: 0.9 }],
      'router.decision': [null],
    });
  });

  it('records breaker changes seen during the call', () => {
    const r = recorder();
    r.noteBreaker({ provider: 'primary', model: 'm', from: 'closed', to: 'open' });

    expect(r.finish(ok)!.breaker).toEqual([
      { provider: 'primary', model: 'm', from: 'closed', to: 'open' },
    ]);
  });
});

describe('finish', () => {
  it('produces the record once', () => {
    const r = recorder();

    expect(r.finish(ok)).toBeDefined();
    expect(r.finish(ok)).toBeUndefined();
    expect(r.finish(failure(serverError()))).toBeUndefined();
  });

  it('drops every signal that arrives after the end', () => {
    const r = recorder();
    r.finish(ok);

    expect(() => {
      r.openAttempt(attemptCtx());
      r.retried(1, serverError());
      r.fellBack(1, serverError());
      r.queued(5);
      r.setUsage(
        { promptTokens: 1, completionTokens: 1, totalTokens: 2, requestId: 'r', model: 'm' },
        false,
      );
      r.noteBreaker({ provider: 'p', model: 'm', from: 'a', to: 'b' });
      r.noteMiddleware({ kind: 'transform', name: 'a' });
      r.addCustom('usage.x', 1);
    }).not.toThrow();
  });

  it('times a stream from the call start to its first chunk, and its rate after that', () => {
    const r = recorder();
    vi.advanceTimersByTime(5);
    r.openAttempt(attemptCtx());
    vi.advanceTimersByTime(95);
    r.responded();
    r.markStream();
    r.setUsage(
      { promptTokens: 1, completionTokens: 50, totalTokens: 51, requestId: 'r', model: 'm' },
      false,
    );
    vi.advanceTimersByTime(500);

    const record = r.finish(ok)!;

    expect(record.streaming).toBe(true);
    expect(record.ttftMs).toBe(100);
    expect(record.durationMs).toBe(600);
    // 50 tokens over the 500 ms after the first chunk.
    expect(record.outputTokensPerSec).toBe(100);
  });

  it('leaves ttftMs out when the stream failed before any chunk', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.markStream();

    const record = r.finish(failure(serverError()))!;

    expect(record.streaming).toBe(true);
    expect(record).not.toHaveProperty('ttftMs');
  });

  it('takes cache from the result, and only for an ok answer', () => {
    expect(recorder().finish(ok)!.cache).toBeUndefined();
    expect(recorder().finish({ kind: 'result', result: { value: 'x', cache: 'hit' } })!.cache).toBe(
      'hit',
    );
    expect(
      recorder().finish({ kind: 'result', result: { value: 'x', cache: 'join' } })!.cache,
    ).toBe('join');

    expect(recorder().finish(failure(serverError()))!.cache).toBeUndefined();
  });

  it('takes who answered from the meta, and nothing when there is none', () => {
    const answered = recorder().finish({
      kind: 'result',
      result: {
        value: 'x',
        meta: {
          provider: 'fallback[0]',
          model: 'claude-x',
          fallbackIndex: 0,
          usedFallback: true,
          attempts: 1,
          position: 1,
        },
      },
    })!;

    expect(answered).toMatchObject({
      provider: 'fallback[0]',
      model: 'claude-x',
      fallbackIndex: 0,
    });
    expect(recorder().finish(ok)).not.toHaveProperty('provider');
  });

  it('stamps the time the call ended, and times the call from the monotonic clock', () => {
    const r = recorder();
    vi.advanceTimersByTime(250);

    const record = r.finish(ok)!;

    expect(record.ts).toBe('2026-01-01T00:00:00.250Z');
    expect(record.durationMs).toBe(250);
  });

  it('copies the allowlisted context and runs the enrichers at the end', () => {
    const enrich = vi.fn(() => ({ traceId: 'abc' }));
    const ctx = preDispatch({ context: { tenantId: 'acme', secret: 'x' } });
    const r = recorder({ context: ['tenantId'], enrich }, ctx);

    const record = r.finish(ok)!;

    expect(record.context).toEqual({ tenantId: 'acme' });
    expect(record.fields).toEqual({ traceId: 'abc' });
    expect(enrich).toHaveBeenCalledWith(ctx);
  });

  it('classifies a failure through the one outcome function', () => {
    const record = recorder().finish(failure(new LLMError('x', 'quota_exceeded')))!;
    expect(record).toMatchObject({
      outcome: 'rejected',
      level: 'warn',
      error: { type: 'quota_exceeded' },
    });
  });
});

describe('recorder edges', () => {
  it('ignores a retry delay that is zero, negative or not a number', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.retried(0, serverError());
    r.openAttempt(attemptCtx());
    r.retried(Number.NaN, serverError());
    r.openAttempt(attemptCtx());
    r.retried(-5, serverError());

    expect(r.finish(ok)!.retryDelayMs).toBe(0);
  });

  it('keeps a custom event with no data as null', () => {
    const r = recorder();
    r.addCustom('x.y', undefined);
    r.addCustom('x.y', undefined);

    expect(r.finish(ok)!.custom).toEqual({ 'x.y': [null, null] });
  });

  it('does not mark a call as a stream after it ended', () => {
    const r = recorder();
    r.finish(ok);
    r.markStream();

    expect(r.finish(ok)).toBeUndefined();
  });

  it('measures a stream that never responded to the end of the call', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.markStream();
    vi.advanceTimersByTime(30);

    const record = r.finish(ok)!;

    expect(record.attemptMs).toBe(30);
    expect(record).not.toHaveProperty('ttftMs');
  });
});

describe('attempt tallies', () => {
  const softFailure = () => new LLMError('x', 'api', { code: 'soft_failure_detected' as never });

  it('counts a responded attempt that failed validation, then the answering one', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.responded();
    r.retried(5, softFailure());
    r.openAttempt(attemptCtx());
    r.responded();

    expect(talliesOf(r.finish(ok)!)).toEqual([
      { provider: 'primary', model: 'gpt-4o', responded: 2, qualityFailures: 1 },
    ]);
  });

  it('keeps an attempt that never got a response out of the denominator', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(serverError());
    r.retried(5, serverError());
    r.openAttempt(attemptCtx());
    r.responded();

    expect(talliesOf(r.finish(ok)!)).toEqual([
      { provider: 'primary', model: 'gpt-4o', responded: 1, qualityFailures: 0 },
    ]);
  });

  it('counts a quality failure the adapter threw as a response, even if dispatch rejected', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(softFailure());

    expect(talliesOf(r.finish(failure(softFailure()))!)).toEqual([
      { provider: 'primary', model: 'gpt-4o', responded: 1, qualityFailures: 1 },
    ]);
  });

  it('tallies each target apart, a fallback included', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary'));
    r.responded();
    r.fellBack(10, softFailure());
    r.openAttempt(attemptCtx('backup', 'gpt-4o-mini'));
    r.responded();

    expect(talliesOf(r.finish(ok)!)).toEqual([
      { provider: 'primary', model: 'gpt-4o', responded: 1, qualityFailures: 1 },
      { provider: 'backup', model: 'gpt-4o-mini', responded: 1, qualityFailures: 0 },
    ]);
  });

  it('counts the last attempt of an exhausted chain by its own error', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.responded();
    const exhausted = Object.assign(new LLMError('x', 'fallback_exhausted'), {
      attempts: [{ error: { type: 'api', code: 'soft_failure_detected' } }],
    });

    expect(talliesOf(r.finish(failure(exhausted))!)).toEqual([
      { provider: 'primary', model: 'gpt-4o', responded: 1, qualityFailures: 1 },
    ]);
  });

  it('counts nothing for an attempt that was rejected before anything was sent', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.attemptFailed(
      new LLMError('no', 'invalid_params', { code: 'unsupported_capability' as never }),
    );

    expect(talliesOf(r.finish(failure(new LLMError('no', 'invalid_params')))!)).toBeUndefined();
  });

  it('counts nothing for a call that never reached a provider', () => {
    expect(talliesOf(recorder().finish(ok)!)).toBeUndefined();
  });

  it('leaves the record itself unchanged', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.responded();

    expect(Object.keys(r.finish(ok)!)).not.toContain('tallies');
  });
});

describe('calls with more than one chain', () => {
  const answeredBy = (chain?: number) =>
    ({
      kind: 'result',
      result: {
        value: 'x',
        meta: {
          provider: 'primary',
          model: 'gpt-4o',
          fallbackIndex: -1,
          usedFallback: false,
          attempts: 1,
          position: 0,
          ...(chain === undefined ? {} : { chain }),
        },
      },
    }) as const;
  const usage = (totalTokens: number) => ({
    promptTokens: 1,
    completionTokens: totalTokens - 1,
    totalTokens,
    requestId: 'r',
    model: 'm',
  });

  it('writes no chain fields for a call that ran one chain', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.responded();

    expect(r.finish(answeredBy())!).not.toHaveProperty('chains');
    expect(recorder().finish(ok)!).not.toHaveProperty('chain');
  });

  it('keeps each chain apart, so an attempt of one never closes an attempt of the other', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    r.openAttempt(attemptCtx('backup', 'gpt-4o-mini', 1));
    r.responded(1);

    const record = r.finish(answeredBy(1))!;

    expect(record).toMatchObject({ attempts: 2, chains: 2, chain: 1 });
  });

  it('takes attemptMs and ttftMs from the kept chain only', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    vi.advanceTimersByTime(100);
    r.openAttempt(attemptCtx('backup', 'gpt-4o-mini', 1));
    vi.advanceTimersByTime(30);
    r.responded(1);
    r.markStream();
    vi.advanceTimersByTime(20);

    const record = r.finish(answeredBy(1))!;

    // Chain 1 answered 30 ms after it began and 130 ms after the call began.
    expect(record.attemptMs).toBe(30);
    expect(record.ttftMs).toBe(130);
    expect(record.durationMs).toBe(150);
  });

  it('measures the main chain when it is the one kept, however the other chain ended', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    vi.advanceTimersByTime(40);
    r.openAttempt(attemptCtx('backup', 'gpt-4o-mini', 1));
    vi.advanceTimersByTime(10);
    r.responded(0);
    vi.advanceTimersByTime(5);

    const record = r.finish(answeredBy())!;

    expect(record).toMatchObject({ attempts: 2, chains: 2, chain: 0, attemptMs: 50 });
  });

  it('lists the path of the kept chain, not of the others', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    r.openAttempt(attemptCtx('backup', 'gpt-4o-mini', 1));
    vi.advanceTimersByTime(25);
    r.responded(1);

    expect(r.finish(answeredBy(1))!.path).toEqual([
      { provider: 'backup', model: 'gpt-4o-mini', attempts: 1, outcome: 'ok', elapsedMs: 25 },
    ]);
  });

  it('applies a retry and a fallback to the chain they came from', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    r.responded(0);
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 1));
    r.attemptFailed(serverError(), 1);
    r.retried(5, serverError(), 1);
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 1));
    r.responded(1);

    const record = r.finish(answeredBy(1))!;

    expect(record).toMatchObject({ attempts: 3, retries: 1, chains: 2, chain: 1 });
    expect(record.path[0]!.attempts).toBe(2);
    // The first chain's attempt was left open by the retry in the other one.
    expect(talliesOf(record)).toEqual([
      { provider: 'primary', model: 'gpt-4o', responded: 1, qualityFailures: 0 },
    ]);
  });

  it('takes the usage of the kept chain', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 1));
    r.setUsage(usage(10), true, 0);
    r.setUsage(usage(7), false, 1);

    const record = r.finish(answeredBy(1))!;

    expect(record.usage!.totalTokens).toBe(7);
    expect(record).not.toHaveProperty('usageFailed');
  });

  it('records the main chain when every chain failed', () => {
    const r = recorder();
    r.openAttempt(attemptCtx('primary', 'gpt-4o', 0));
    r.attemptFailed(serverError(), 0);
    r.openAttempt(attemptCtx('backup', 'gpt-4o-mini', 1));
    r.attemptFailed(serverError(), 1);

    const record = r.finish(failure(serverError()))!;

    expect(record).toMatchObject({ outcome: 'error', attempts: 2, chains: 2, chain: 0 });
    expect(record.path).toMatchObject([{ provider: 'primary', outcome: 'error' }]);
  });

  it('counts a chain from its retry or fallback even if its attempt never opened', () => {
    const r = recorder();
    r.openAttempt(attemptCtx());
    r.fellBack(10, serverError(), 1);

    expect(r.finish(ok)!).toMatchObject({ chains: 2, chain: 0 });
  });

  it('ignores a closing signal for a chain it never saw', () => {
    const r = recorder();

    expect(() => {
      r.responded(3);
      r.attemptFailed(serverError(), 3);
    }).not.toThrow();
    expect(r.finish(ok)!).not.toHaveProperty('chains');
  });
});
