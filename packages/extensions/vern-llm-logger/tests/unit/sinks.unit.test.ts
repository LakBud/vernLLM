import { describe, expect, it, vi } from 'vitest';

import { consoleSink, jsonSink, memorySink } from '../../src/sinks.js';

import type { BreakerEntry, CallLogRecord, LogEntry, SummaryEntry } from '../../src/index.js';

const breaker: BreakerEntry = {
  kind: 'breaker',
  v: 1,
  provider: 'primary',
  model: 'gpt-4o',
  from: 'closed',
  to: 'open',
  consecutiveFailures: 5,
};

describe('jsonSink', () => {
  it('writes one JSON line per entry', () => {
    const write = vi.fn();
    jsonSink({ write }).write('warn', breaker);

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toEqual(breaker);
    expect(write.mock.calls[0]?.[0]).not.toContain('\n');
  });

  it('defaults to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    jsonSink().write('info', breaker);

    expect(spy).toHaveBeenCalledWith(JSON.stringify(breaker));
    spy.mockRestore();
  });

  it('looks up console.log at write time, so a later spy still sees it', () => {
    const sink = jsonSink();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    sink.write('info', breaker);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('memorySink', () => {
  it('keeps entries in order with their level', () => {
    const sink = memorySink();
    const second: LogEntry = { ...breaker, to: 'half_open' };

    sink.write('warn', breaker);
    sink.write('info', second);

    expect(sink.entries).toEqual([
      { level: 'warn', entry: breaker },
      { level: 'info', entry: second },
    ]);
  });

  it('clears in place, so a held reference sees the reset', () => {
    const sink = memorySink();
    const held = sink.entries;

    sink.write('info', breaker);
    sink.clear();

    expect(held).toHaveLength(0);
    expect(sink.entries).toHaveLength(0);
  });
});

describe('consoleSink', () => {
  const line = (entry: LogEntry) => {
    const write = vi.fn();
    consoleSink({ write }).write('info', entry);
    return write.mock.calls[0]?.[0] as string;
  };
  const call: CallLogRecord = {
    kind: 'call',
    v: 1,
    ts: 't',
    requestId: 'req_abc',
    outcome: 'ok',
    level: 'info',
    provider: 'primary',
    model: 'gpt-6-sol',
    attempts: 2,
    retries: 1,
    streaming: true,
    durationMs: 1840,
    ttftMs: 312,
    queueWaitMs: 0,
    retryDelayMs: 0,
    path: [],
  };

  it('writes one readable line for a call', () => {
    expect(line(call)).toBe('[VernLLM] ok primary/gpt-6-sol 1.84s ttft 312ms 2 attempts req_abc');
  });

  it('shows what is notable and leaves out what is not', () => {
    expect(line({ ...call, attempts: 1, ttftMs: undefined, durationMs: 40 })).toBe(
      '[VernLLM] ok primary/gpt-6-sol 40ms req_abc',
    );
    expect(line({ ...call, attempts: 0, cache: 'hit', ttftMs: undefined })).toContain('cache hit');
    expect(
      line({ ...call, outcome: 'error', error: { type: 'api', code: 'server_error' } }),
    ).toContain('api/server_error');
    expect(line({ ...call, reason: 'slow' })).toContain('slow');
  });

  it('describes the other entries', () => {
    expect(line(breaker)).toBe('[VernLLM] breaker primary/gpt-4o closed -> open');
    expect(
      line({
        kind: 'error_group',
        v: 1,
        provider: 'primary',
        type: 'api',
        code: 'server_error',
        count: 7,
        windowMs: 60_000,
        firstRequestId: 'a',
        lastRequestId: 'b',
      }),
    ).toBe('[VernLLM] error_group primary api/server_error x7 in 60.00s');
    expect(
      line({
        kind: 'summary',
        v: 1,
        series: {
          metric: 'durationMs',
          dimensions: { provider: 'primary' },
          count: 30,
          quantiles: { '0.99': 2500 },
          errors: 2,
          rejections: 0,
          aborts: 0,
          cacheHits: 0,
        },
      }),
    ).toBe('[VernLLM] summary durationMs primary n=30 p99 2.50s errors 2');
  });

  it('writes to the console method for the level by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleSink().write('warn', breaker);

    expect(warn).toHaveBeenCalledWith('[VernLLM] breaker primary/gpt-4o closed -> open');
    warn.mockRestore();
  });
});

describe('consoleSink lines', () => {
  const callRecord = (extra: Partial<CallLogRecord> = {}): CallLogRecord => ({
    kind: 'call',
    v: 1,
    ts: '2026-01-01T00:00:00.000Z',
    requestId: 'req',
    outcome: 'ok',
    level: 'info',
    attempts: 1,
    retries: 0,
    streaming: false,
    durationMs: 1500,
    queueWaitMs: 0,
    retryDelayMs: 0,
    path: [],
    ...extra,
  });
  const lineOf = (entry: LogEntry) => {
    const write = vi.fn();
    consoleSink({ write }).write('info', entry);
    return write.mock.calls[0]?.[0] as string;
  };

  it('names the target only when there is one, and an error code only when there is one', () => {
    expect(lineOf(callRecord())).toBe('[VernLLM] ok 1.50s req');
    expect(
      lineOf(
        callRecord({
          provider: 'p',
          model: 'm',
          outcome: 'error',
          error: { type: 'api' },
          attempts: 2,
        }),
      ),
    ).toBe('[VernLLM] error p/m 1.50s 2 attempts api req');
    expect(
      lineOf(callRecord({ outcome: 'error', error: { type: 'api', code: 'server_error' } })),
    ).toContain('api/server_error');
  });

  it('describes an error group with and without a code', () => {
    const group = {
      kind: 'error_group',
      v: 1,
      provider: 'p',
      type: 'api',
      count: 3,
      windowMs: 60_000,
      firstRequestId: 'a',
      lastRequestId: 'b',
    } as const;

    expect(lineOf(group)).toBe('[VernLLM] error_group p api x3 in 60.00s');
    expect(lineOf({ ...group, code: 'server_error' })).toContain('api/server_error x3');
  });

  it('describes a summary with and without dimensions or a p99', () => {
    const summary = (series: Partial<SummaryEntry['series']>): SummaryEntry => ({
      kind: 'summary',
      v: 1,
      series: {
        metric: 'durationMs',
        dimensions: {},
        count: 4,
        quantiles: {},
        errors: 0,
        rejections: 0,
        aborts: 0,
        cacheHits: 0,
        ...series,
      },
    });

    expect(lineOf(summary({}))).toBe('[VernLLM] summary durationMs all n=4 errors 0');
    expect(lineOf(summary({ dimensions: { provider: 'p' }, quantiles: { '0.99': 250 } }))).toBe(
      '[VernLLM] summary durationMs p n=4 p99 250ms errors 0',
    );
  });

  it('defaults to the console method for the level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    consoleSink().write('info', breaker);
    consoleSink().write('warn', breaker);

    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    log.mockRestore();
    warn.mockRestore();
  });
});
