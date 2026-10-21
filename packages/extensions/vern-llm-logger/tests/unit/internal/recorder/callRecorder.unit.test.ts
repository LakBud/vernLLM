import { LLMError, type AttemptContext, type PreDispatchContext } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { CallRecorder } from '../../../../src/internal/recorder/callRecorder.js';

import type { LoggerMiddlewareOptions } from '../../../../src/index.js';

// The attempt model driven directly, one signal at a time, for the orders and edge cases a real
// VernLLM rarely produces.

const preDispatch = (extra: Partial<PreDispatchContext> = {}) =>
  ({ requestId: 'req_1', context: undefined, ...extra }) as PreDispatchContext;
const attemptCtx = (provider = 'primary', model = 'gpt-4o') =>
  ({ requestedProvider: provider, requestedModel: model }) as AttemptContext;

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
    r.retried(25);
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
    r.retried(5);
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
    r.retried(1);
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
      r.retried(1);
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
    r.retried(0);
    r.openAttempt(attemptCtx());
    r.retried(Number.NaN);
    r.openAttempt(attemptCtx());
    r.retried(-5);

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
