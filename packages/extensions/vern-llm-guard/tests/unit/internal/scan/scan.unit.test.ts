import { describe, expect, it, vi } from 'vitest';

import { compile } from '../../../../src/internal/options/compile.utils.js';
import { createMemo } from '../../../../src/internal/scan/memo.utils.js';
import { scan } from '../../../../src/internal/scan/scan.js';

import type { Check, Detector, Finding, Segment } from '../../../../src/index.js';
import type { CallCache, Memo, ScanResult, Span } from '../../../../src/internal/scan/types.js';

const user = (text: string): Segment => ({ text, source: 'user' });
const tool = (text: string): Segment => ({ text, source: 'tool' });

/** A detector that finds `needle` in every segment, and remembers what it was given. */
function finds(needle: string, kind = 'hit') {
  const calls: Segment[][] = [];
  const detect: Detector = (segments) => {
    calls.push([...segments]);
    return segments.flatMap((segment, index): Finding[] => {
      const start = segment.text.indexOf(needle);
      return start === -1
        ? []
        : [{ segment: index, label: kind, start, end: start + needle.length }];
    });
  };
  return { detect: vi.fn(detect), calls };
}

const later = <T>(value: T, ms = 0): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

function setup(checks: Check[], options: { onError?: 'open' | 'closed'; version?: string } = {}) {
  const compiled = compile({ version: options.version ?? 'v1', checks, ...options });
  const cache: CallCache = new Map();
  const memo = createMemo(100);
  const run = (
    segments: Segment[],
    deps: Partial<Parameters<typeof scan>[3]> = {},
  ): ScanResult | Promise<ScanResult> =>
    scan(compiled, segments, cache, {
      memo,
      ctx: { context: undefined, streaming: false },
      ...deps,
    });
  return { compiled, cache, memo, run };
}

const isPromise = (value: unknown): boolean => value instanceof Promise;

describe('labels and blocks', () => {
  it('labels the call with a check label, once, in the order of the checks', async () => {
    const a = finds('x');
    const b = finds('y');
    const { run } = setup([
      { id: 'second', detect: b.detect, label: 'why' },
      { id: 'first', detect: a.detect, label: 'ex' },
    ]);

    const result = await run([user('x and y')]);

    expect(result.labels).toEqual(['why', 'ex']);
    expect(result.unknown).toBe(false);
    expect(result.blocked).toBeUndefined();
    expect(result.report.checks).toEqual({
      second: { found: 1, kinds: ['hit'], ms: expect.any(Number) },
      first: { found: 1, kinds: ['hit'], ms: expect.any(Number) },
    });
  });

  it('uses the id as the label by default, and finds nothing as []', async () => {
    const { run } = setup([
      { id: 'pii', detect: finds('@').detect },
      { id: 'quiet', detect: finds('zzz').detect },
    ]);

    expect((await run([user('a@b')])).labels).toEqual(['pii']);
    const none = await run([user('plain')]);
    expect(none.labels).toEqual([]);
    expect(none.unknown).toBe(false);
  });

  it('shares one label between checks without repeating it', async () => {
    const { run } = setup([
      { id: 'a', detect: finds('x').detect, label: 'same' },
      { id: 'b', detect: finds('x').detect, label: 'same' },
    ]);
    expect((await run([user('x')])).labels).toEqual(['same']);
  });

  it('blocks when an enforced block check finds something', async () => {
    const { run } = setup([{ id: 'secrets', detect: finds('sk-').detect, action: 'block' }]);
    const result = await run([user('key sk-123')]);

    expect(result.blocked).toEqual({ check: 'secrets', label: 'secrets', failed: false });
    expect(result.labels).toEqual(['secrets']);
  });

  it('counts every finding, in every segment', async () => {
    const { run } = setup([{ id: 'x', detect: finds('x').detect }]);
    const result = (await run([user('x'), user('no'), tool('x')])) as ScanResult;
    expect(result.report.checks.x!.found).toBe(2);
  });
});

describe('what a check is given', () => {
  it('only the segments of the sources it is on, with indexes into its own batch', async () => {
    const seen: Segment[][] = [];
    const detect: Detector = (segments) => {
      seen.push([...segments]);
      return [{ segment: 1, start: 0, end: 1 }];
    };
    const { run } = setup([{ id: 'tools', detect, on: 'tool' }]);

    const result = (await run([user('u1'), tool('t1'), user('u2'), tool('t2')])) as ScanResult;

    expect(seen).toEqual([[tool('t1'), tool('t2')]]);
    expect(result.report.checks.tools!.found).toBe(1);
  });

  it('skips a check with no segment to read, without a report', async () => {
    const detector = finds('x');
    const { run } = setup([{ id: 'tools', detect: detector.detect, on: 'tool' }]);

    const result = (await run([user('x')])) as ScanResult;

    expect(detector.detect).not.toHaveBeenCalled();
    expect(result.report.checks).toEqual({});
    expect(result.labels).toEqual([]);
  });

  it('skips a check its own when rules out, and counts it as ran with nothing found', async () => {
    const detector = finds('x');
    const { run } = setup([{ id: 'a', detect: detector.detect, when: () => false }]);

    const result = (await run([user('x')])) as ScanResult;

    expect(detector.detect).not.toHaveBeenCalled();
    expect(result.labels).toEqual([]);
    expect(result.unknown).toBe(false);
  });

  it('gives when the call it asks about', async () => {
    const when = vi.fn(() => true);
    const { run } = setup([{ id: 'a', detect: finds('x').detect, when }]);
    await run([user('x')], { ctx: { context: { tenant: 'acme' }, streaming: true } });
    expect(when).toHaveBeenCalledWith({ context: { tenant: 'acme' }, streaming: true });
  });
});

describe('sync and async', () => {
  it('stays synchronous when every detector answers with an array', () => {
    const { run } = setup([{ id: 'a', detect: finds('x').detect }]);
    const result = run([user('x')]);
    expect(isPromise(result)).toBe(false);
    expect((result as ScanResult).labels).toEqual(['a']);
  });

  it('is a promise as soon as one detector is, and awaits it', async () => {
    const { run } = setup([
      { id: 'fast', detect: finds('x').detect },
      {
        id: 'slow',
        detect: async (segments) =>
          later(
            segments.map((_s, segment) => ({ segment })),
            5,
          ),
      },
    ]);
    const result = run([user('x')]);
    expect(isPromise(result)).toBe(true);
    expect((await result).labels).toEqual(['fast', 'slow']);
  });

  it('starts no later detector once a synchronous block has fired', () => {
    const slow = vi.fn(async () => later([]));
    const after = finds('x');
    const { run } = setup([
      { id: 'first', detect: finds('x').detect, action: 'block' },
      { id: 'slow', detect: slow },
      { id: 'after', detect: after.detect },
    ]);

    const result = run([user('x')]);

    expect(isPromise(result)).toBe(false);
    expect(slow).not.toHaveBeenCalled();
    expect(after.detect).not.toHaveBeenCalled();
    expect((result as ScanResult).blocked?.check).toBe('first');
  });

  it('runs async detectors at the same time, not one after another', async () => {
    const delay = (): Detector => async () => later([], 40);
    const { run } = setup([
      { id: 'a', detect: delay() },
      { id: 'b', detect: delay() },
      { id: 'c', detect: delay() },
    ]);

    const started = performance.now();
    await run([user('x')]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('ends at the first async block, aborts the others, and lists what had finished', async () => {
    let otherSignal: AbortSignal | undefined;
    const { run } = setup([
      { id: 'quick-ok', detect: async () => later([], 1) },
      { id: 'blocker', detect: async () => later([{ segment: 0 }], 10), action: 'block' },
      {
        id: 'slow',
        detect: (_segments, signal) => {
          otherSignal = signal;
          return later([], 500);
        },
      },
    ]);

    const started = performance.now();
    const result = await run([user('x')]);

    expect(performance.now() - started).toBeLessThan(300);
    expect(result.blocked).toEqual({ check: 'blocker', label: 'blocker', failed: false });
    expect(Object.keys(result.report.checks)).toEqual(['quick-ok', 'blocker']);
    expect(otherSignal?.aborted).toBe(true);
  });

  it('passes the call signal on to its detectors', async () => {
    const call = new AbortController();
    let seen: AbortSignal | undefined;
    const { run } = setup([
      {
        id: 'a',
        detect: (_segments, signal) => {
          seen = signal;
          return [];
        },
      },
    ]);

    await run([user('x')], { signal: call.signal });
    expect(seen?.aborted).toBe(false);
    call.abort();
    expect(seen?.aborted).toBe(true);
  });
});

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

describe('audit', () => {
  it('changes nothing: no label, no block', async () => {
    const { run } = setup([
      { id: 'inj', detect: finds('x').detect, action: 'block', mode: 'audit' },
      { id: 'pii', detect: finds('x').detect, mode: 'audit' },
    ]);

    const result = await run([user('x')]);

    expect(result.labels).toEqual([]);
    expect(result.blocked).toBeUndefined();
    expect(result.report.audit).toEqual({ inj: 'block', pii: 'label' });
    expect(result.report.checks.inj!.found).toBe(1);
  });

  it('says nothing when the audit check found nothing', async () => {
    const { run } = setup([
      { id: 'inj', detect: finds('zzz').detect, action: 'block', mode: 'audit' },
    ]);
    expect((await run([user('x')])).report.audit).toEqual({});
  });
});

describe('the call cache and the memo', () => {
  it('answers text already scanned in this call without asking the detector again', async () => {
    const detector = finds('x');
    const { run } = setup([{ id: 'a', detect: detector.detect }], {});

    const first = await run([user('x one'), user('plain')]);
    const second = await run([user('x one'), user('plain'), user('x new')]);

    expect(detector.calls).toHaveLength(2);
    expect(detector.calls[1]).toEqual([user('x new')]);
    expect(first.report.checks.a).not.toHaveProperty('memo');
    expect(second.report.checks.a).toMatchObject({ found: 2, memo: 2 });
  });

  it('remembers across calls through the memo, and remembers a miss too', async () => {
    const detector = finds('x');
    const { compiled, memo } = setup([{ id: 'a', detect: detector.detect }]);
    const deps = { memo, ctx: { context: undefined, streaming: false } };

    await scan(compiled, [user('x'), user('plain')], new Map(), deps);
    const again = await scan(compiled, [user('x'), user('plain')], new Map(), deps);

    expect(detector.calls).toHaveLength(1);
    expect(again.labels).toEqual(['a']);
    expect(again.report.checks.a).toMatchObject({ found: 1, memo: 2 });
  });

  it('reads the memo but writes nothing to it when it is read only', async () => {
    const detector = finds('x');
    const { compiled, memo } = setup([{ id: 'a', detect: detector.detect }]);
    const deps = { memo, ctx: { context: undefined, streaming: false } };

    await scan(compiled, [user('x')], new Map(), deps);
    const known = memo!.size;
    const read = await scan(compiled, [user('x'), user('other')], new Map(), {
      ...deps,
      memoReadOnly: true,
    });

    expect(read.report.checks.a).toMatchObject({ found: 1, memo: 1 });
    expect(memo!.size).toBe(known);
  });

  it('works without a memo, through the call cache alone', async () => {
    const detector = finds('x');
    const { compiled } = setup([{ id: 'a', detect: detector.detect }]);
    const cache: CallCache = new Map();
    const deps = { memo: undefined, ctx: { context: undefined, streaming: false } };

    await scan(compiled, [user('x')], cache, deps);
    await scan(compiled, [user('x')], cache, deps);
    expect(detector.calls).toHaveLength(1);
  });

  it('does not share findings between checks, sources or versions', async () => {
    const one = finds('x');
    const two = finds('x');
    const memo = createMemo(100);
    const ctx = { context: undefined, streaming: false };

    const v1 = compile({ version: 'v1', checks: [{ id: 'a', detect: one.detect }] });
    const v2 = compile({ version: 'v2', checks: [{ id: 'a', detect: two.detect }] });
    await scan(v1, [user('x')], new Map(), { memo, ctx });
    await scan(v2, [user('x')], new Map(), { memo, ctx });
    await scan(v1, [tool('x')], new Map(), { memo, ctx });
    const other = compile({ version: 'v1', checks: [{ id: 'b', detect: two.detect }] });
    await scan(other, [user('x')], new Map(), { memo, ctx });

    expect(one.calls).toHaveLength(2);
    expect(two.calls).toHaveLength(2);
  });

  it('holds offsets and kinds, never text', async () => {
    const stored: [string, readonly Span[]][] = [];
    const memo: Memo = {
      get: () => undefined,
      set: (key, spans) => void stored.push([key, spans]),
      size: 0,
    };
    const { compiled } = setup([{ id: 'a', detect: finds('hunter2', 'password').detect }]);

    await scan(compiled, [user('my hunter2 is here')], new Map(), {
      memo,
      ctx: { context: undefined, streaming: false },
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]![1]).toEqual([{ label: 'password', start: 3, end: 10 }]);
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('here');
  });

  it('still remembers what a detector answered after another check ended the scan', async () => {
    const detector = finds('x');
    const slowKnown: Detector = async (segments) => {
      await later(null, 30);
      return detector.detect(segments, new AbortController().signal);
    };
    const { compiled, memo } = setup([
      { id: 'blocker', detect: async () => [{ segment: 0 }], action: 'block' },
      { id: 'slow', detect: slowKnown },
    ]);
    const deps = { memo, ctx: { context: undefined, streaming: false } };

    await scan(compiled, [user('x')], new Map(), deps);
    await later(null, 80);

    const next = await scan(
      compile({ version: 'v1', checks: [{ id: 'slow', detect: detector.detect }] }),
      [user('x')],
      new Map(),
      deps,
    );
    expect(detector.calls).toHaveLength(1);
    expect(next.report.checks.slow).toMatchObject({ found: 1, memo: 1 });
  });
});

describe('createMemo', () => {
  it('is off at zero', () => {
    expect(createMemo(0)).toBeUndefined();
  });

  it('drops the least recently used entry first', () => {
    const memo = createMemo(2)!;
    memo.set('a', []);
    memo.set('b', []);
    memo.get('a');
    memo.set('c', []);

    expect(memo.get('b')).toBeUndefined();
    expect(memo.get('a')).toEqual([]);
    expect(memo.get('c')).toEqual([]);
    expect(memo.size).toBe(2);
  });
});

describe('findings for redaction', () => {
  it('returns each span of a check that redacts, and counts fresh ones', async () => {
    const a = finds('x');
    const { run } = setup([{ id: 'r', detect: a.detect, action: 'redact' }]);

    const first = await run([user('an x here')]);
    const again = await run([user('an x here')]);

    expect(first.findings).toEqual([
      {
        check: expect.objectContaining({ id: 'r' }),
        segment: 0,
        span: expect.objectContaining({ start: 3, end: 4 }),
      },
    ]);
    expect(first.fresh).toBe(1);
    // A cache hit still yields the spans, but nothing new was found.
    expect(again.findings).toHaveLength(1);
    expect(again.fresh).toBe(0);
  });

  it('leaves out the spans a caller asks to skip', async () => {
    const a = finds('x');
    const { run } = setup([{ id: 'r', detect: a.detect, action: 'redact' }]);

    const result = await run([user('an x here')], { skip: () => true });

    expect(result.findings).toEqual([]);
    expect(result.report.checks['r']!.found).toBe(0);
  });

  it('blocks a redact check that found something it cannot replace', async () => {
    const spanless: Detector = () => [{ segment: 0 }];
    const { run } = setup([{ id: 'r', detect: spanless, action: 'redact' }]);

    const result = await run([user('anything')]);

    expect(result.blocked).toBeDefined();
    expect(result.report.checks['r']).toMatchObject({ found: 1, unredactable: 1 });
  });

  it('blocks when a redact check fails and the instance fails closed, and skips it when open', async () => {
    const broken: Detector = () => {
      throw new Error('boom');
    };
    const closed = setup([{ id: 'r', detect: broken, action: 'redact' }], { onError: 'closed' });
    const open = setup([{ id: 'r', detect: broken, action: 'redact' }], { onError: 'open' });

    expect((await closed.run([user('a')])).blocked).toBeDefined();
    expect((await open.run([user('a')])).blocked).toBeUndefined();
  });
});
