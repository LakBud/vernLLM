import { describe, expect, it } from 'vitest';

import { ErrorGrouper } from '../../../../src/internal/detectors/errorGrouper.js';

import type { CallLogRecord } from '../../../../src/index.js';

let id = 0;
const failed = (extra: Partial<CallLogRecord> = {}): CallLogRecord => ({
  kind: 'call',
  v: 1,
  ts: '2026-01-01T00:00:00.000Z',
  requestId: `req_${++id}`,
  outcome: 'error',
  level: 'error',
  provider: 'primary',
  error: { type: 'api', code: 'server_error', status: 500 },
  attempts: 1,
  retries: 0,
  streaming: false,
  durationMs: 10,
  queueWaitMs: 0,
  retryDelayMs: 0,
  path: [],
  ...extra,
});

function setup() {
  const clock = { now: 0 };
  return { grouper: new ErrorGrouper(1000, () => clock.now), clock };
}

describe('ErrorGrouper', () => {
  it('lets the first error of a window through and counts the rest', () => {
    const { grouper } = setup();
    const first = failed();
    const middle = failed();
    const last = failed();

    expect(grouper.offer(first)).toBe(true);
    expect(grouper.offer(middle)).toBe(false);
    expect(grouper.offer(last)).toBe(false);

    expect(grouper.flush(true)).toEqual([
      {
        kind: 'error_group',
        v: 1,
        provider: 'primary',
        type: 'api',
        code: 'server_error',
        count: 3,
        windowMs: 1000,
        firstRequestId: first.requestId,
        lastRequestId: last.requestId,
      },
    ]);
  });

  it('writes no group for an error that happened once', () => {
    const { grouper } = setup();
    grouper.offer(failed());

    expect(grouper.flush(true)).toEqual([]);
  });

  it('keeps different fingerprints apart', () => {
    const { grouper } = setup();

    expect(grouper.offer(failed())).toBe(true);
    expect(grouper.offer(failed({ provider: 'other' }))).toBe(true);
    expect(grouper.offer(failed({ error: { type: 'api', code: 'rate_limited' } }))).toBe(true);
    expect(grouper.offer(failed({ error: { type: 'timeout' } }))).toBe(true);
  });

  it('only flushes a window once it has closed', () => {
    const { grouper, clock } = setup();
    grouper.offer(failed());
    grouper.offer(failed());

    clock.now = 999;
    expect(grouper.flush()).toEqual([]);

    clock.now = 1000;
    expect(grouper.flush()).toHaveLength(1);
    expect(grouper.flush()).toEqual([]);
  });

  it('starts a new window, and reports the closed one, when the same error comes back', () => {
    const { grouper, clock } = setup();
    grouper.offer(failed());
    grouper.offer(failed());

    clock.now = 1500;
    expect(grouper.offer(failed())).toBe(true);

    const entries = grouper.flush();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.count).toBe(2);
  });

  it('attributes an error with no answering provider to the last target tried', () => {
    const { grouper } = setup();
    const path = [
      { provider: 'b', model: 'm', attempts: 1, outcome: 'error' as const, elapsedMs: 1 },
    ];
    grouper.offer(failed({ provider: undefined, path }));
    grouper.offer(failed({ provider: undefined, path }));

    expect(grouper.flush(true)[0]!.provider).toBe('b');
  });

  it('passes a record with no error through untouched', () => {
    const { grouper } = setup();

    expect(grouper.offer(failed({ error: undefined }))).toBe(true);
    expect(grouper.offer(failed({ error: undefined }))).toBe(true);
  });

  it('stops tracking at 500 fingerprints, and lets further errors through', () => {
    const { grouper } = setup();
    for (let i = 0; i < 500; i++) grouper.offer(failed({ provider: `p${i}` }));

    expect(grouper.offer(failed({ provider: 'p-extra' }))).toBe(true);
    expect(grouper.offer(failed({ provider: 'p-extra' }))).toBe(true);
    expect(grouper.offer(failed({ provider: 'p0' }))).toBe(false);
  });
});

describe('ErrorGrouper edges', () => {
  it('leaves the code off a group entry whose errors had none', () => {
    const { grouper } = setup();
    const error = { type: 'timeout' };
    grouper.offer(failed({ error }));
    grouper.offer(failed({ error }));

    const [entry] = grouper.flush(true);

    expect(entry).toMatchObject({ type: 'timeout', count: 2 });
    expect(entry).not.toHaveProperty('code');
  });

  it('forgets every open window on clear', () => {
    const { grouper } = setup();
    grouper.offer(failed());
    grouper.offer(failed());
    grouper.clear();

    expect(grouper.flush(true)).toEqual([]);
    expect(grouper.offer(failed())).toBe(true);
  });
});
