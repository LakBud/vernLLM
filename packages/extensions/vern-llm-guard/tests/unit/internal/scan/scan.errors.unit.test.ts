import { describe, expect, it, vi } from 'vitest';

import { finds, later, setup, user } from './scanHelpers.js';

import type { Check, Detector, Finding } from '../../../../src/index.js';

describe('errors', () => {
  const sync: Detector = () => {
    throw new RangeError('quotes: sk-secret');
  };
  const rejects: Detector = async () => {
    throw new RangeError('quotes: sk-secret');
  };
  const never: Detector = () => new Promise<Finding[]>(() => {});
  const bad: Detector = () => [{ segment: 7 }];

  const modes = { sync, async: rejects, timeout: never, invalid: bad };

  describe.each(Object.entries(modes))('a detector that fails (%s)', (kind, detect) => {
    const named = {
      sync: 'RangeError',
      async: 'RangeError',
      timeout: 'DetectorTimeoutError',
      invalid: 'TypeError',
    }[kind as keyof typeof modes];
    const check = (overrides: Partial<Check>): Check => ({
      id: 'c',
      detect,
      timeoutMs: 20,
      ...overrides,
    });

    it('blocks the call when it blocks and fails closed, saying it failed', async () => {
      const result = await setup([check({ action: 'block' })]).run([user('x')]);
      expect(result.blocked).toEqual({ check: 'c', failed: true });
      expect(result.report.errors).toEqual([{ check: 'c', name: named }]);
    });

    it('makes the labels unknown when it labels and fails closed', async () => {
      const result = await setup([check({ action: 'label' })]).run([user('x')]);
      expect(result.unknown).toBe(true);
      expect(result.blocked).toBeUndefined();
    });

    it('is skipped when it fails open, whatever its action', async () => {
      for (const action of ['block', 'label'] as const) {
        const result = await setup([check({ action, onError: 'open' })]).run([user('x')]);
        expect(result.blocked).toBeUndefined();
        expect(result.unknown).toBe(false);
        expect(result.report.errors).toEqual([{ check: 'c', name: named }]);
      }
    });

    it('changes nothing in audit mode, but is still reported', async () => {
      const result = await setup([check({ action: 'block', mode: 'audit' })]).run([user('x')]);
      expect(result.blocked).toBeUndefined();
      expect(result.unknown).toBe(false);
      expect(result.report.errors).toEqual([{ check: 'c', name: named }]);
    });
  });

  it('takes the instance default for a check that does not choose', async () => {
    const check: Check = { id: 'c', detect: sync, action: 'block' };
    expect((await setup([check], { onError: 'open' }).run([user('x')])).blocked).toBeUndefined();
    expect((await setup([check], { onError: 'closed' }).run([user('x')])).blocked).toBeDefined();
  });

  it('reports the kind of error, never its message', async () => {
    const result = await setup([{ id: 'c', detect: sync, action: 'block' }]).run([user('x')]);
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('keeps going past a failing check that is open, and still finds with the next', async () => {
    const { run } = setup([
      { id: 'broken', detect: sync, onError: 'open' },
      { id: 'works', detect: finds('x').detect },
    ]);
    expect((await run([user('x')])).labels).toEqual(['works']);
  });

  it('treats a throwing when as a failure of the check', async () => {
    const when = () => {
      throw new Error('boom');
    };
    const blocked = await setup([
      { id: 'c', detect: finds('x').detect, action: 'block', when },
    ]).run([user('x')]);
    expect(blocked.blocked).toEqual({ check: 'c', failed: true });
    const unknown = await setup([{ id: 'c', detect: finds('x').detect, when }]).run([user('x')]);
    expect(unknown.unknown).toBe(true);
  });

  it.each([
    ['a span past the text', { segment: 0, start: 0, end: 99 }],
    ['an empty span', { segment: 0, start: 2, end: 2 }],
    ['half a span', { segment: 0, start: 0 }],
    ['a label that is not a string', { segment: 0, label: 5 }],
    ['a segment that was not given', { segment: -1 }],
    ['a fractional segment', { segment: 0.5 }],
    ['nothing at all', null],
  ])('treats %s as a failure of the detector', async (_name, finding) => {
    const detect = (() => [finding]) as unknown as Detector;
    const result = await setup([{ id: 'c', detect, action: 'block' }]).run([user('abc')]);
    expect(result.report.errors).toEqual([{ check: 'c', name: 'TypeError' }]);
  });

  it('treats an answer that is not a list as a failure', async () => {
    const detect = (() => 'no') as unknown as Detector;
    const result = await setup([{ id: 'c', detect }]).run([user('abc')]);
    expect(result.unknown).toBe(true);
  });
});

describe('an async detector that answers badly', () => {
  const notAList: Detector = () => later('nope' as unknown as Finding[]);

  it('fails the check, and follows onError', async () => {
    const { run } = setup([{ id: 'a', detect: notAList, action: 'block' }]);
    expect(await run([user('x')])).toMatchObject({
      blocked: { check: 'a' },
      report: { errors: [{ name: 'TypeError' }] },
    });
  });

  it('is ignored when another check already ended the scan', async () => {
    const slowBad: Detector = () => later('nope' as unknown as Finding[], 20);
    const slowFail: Detector = () =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20));
    const quick = finds('x');
    const { run } = setup(
      [
        { id: 'bad', detect: slowBad, onError: 'open' },
        { id: 'failing', detect: slowFail, onError: 'open' },
        { id: 'quick', detect: quick.detect, action: 'block' },
      ],
      { onError: 'open' },
    );

    const result = await run([user('x')]);
    await later(40);

    expect(result.blocked).toMatchObject({ check: 'quick' });
    expect(result.report.errors).toEqual([]);
  });
});

describe('timeouts', () => {
  it('stop waiting for a slow detector and abort it', async () => {
    let signal: AbortSignal | undefined;
    const { run } = setup([
      {
        id: 'slow',
        timeoutMs: 20,
        detect: (_segments, given) => {
          signal = given;
          return new Promise(() => {});
        },
      },
    ]);

    const started = performance.now();
    const result = await run([user('x')]);

    expect(performance.now() - started).toBeLessThan(200);
    expect(result.unknown).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('never run past the deadline of the call', async () => {
    const { run } = setup([{ id: 'slow', timeoutMs: 5000, detect: () => new Promise(() => {}) }]);

    const started = performance.now();
    const result = await run([user('x')], { deadlineAt: Date.now() + 30 });

    expect(performance.now() - started).toBeLessThan(500);
    expect(result.report.errors).toEqual([{ check: 'slow', name: 'DetectorTimeoutError' }]);
  });

  it('do not leave a timer behind for a detector that answered', async () => {
    vi.useFakeTimers();
    try {
      const { run } = setup([{ id: 'a', timeoutMs: 1000, detect: async () => [] }]);
      const result = run([user('x')]);
      await vi.advanceTimersByTimeAsync(0);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
