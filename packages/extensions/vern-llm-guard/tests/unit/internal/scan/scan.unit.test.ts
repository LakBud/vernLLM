import { describe, expect, it, vi } from 'vitest';

import { finds, image, isPromise, later, readsImages, setup, tool, user } from './scanHelpers.js';

import type { Detector, Segment } from '../../../../src/index.js';
import type { ScanResult } from '../../../../src/internal/scan/types.js';

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

describe('images', () => {
  it('go only to a detector that asked for them', async () => {
    const text = finds('x');
    const pictures = readsImages();
    const { run } = setup([
      { id: 'text', detect: text.detect },
      { id: 'pic', detect: pictures.detect },
    ]);

    const result = await run([user('x'), image('AAAA'), user('y')]);

    expect(text.calls).toEqual([[user('x'), user('y')]]);
    expect(pictures.calls[0]).toEqual([user('x'), image('AAAA'), user('y')]);
    // Indexes are into the batch each detector got, so the image is second for one and first for none.
    expect(result.report.checks.pic).toMatchObject({ found: 1, kinds: ['pic'] });
  });

  it('count as read only when a check that takes images covered them', async () => {
    const covered = new Set<number>();
    const { run } = setup([{ id: 'pic', detect: readsImages().detect, on: 'tool' }]);
    await run([user('x'), image('AAAA')], { covered });
    expect(covered.size).toBe(0);

    const { run: runUser } = setup([{ id: 'pic', detect: readsImages().detect, on: 'user' }]);
    await runUser([user('x'), image('AAAA'), image('BBBB')], { covered });
    expect([...covered]).toEqual([1, 2]);
  });

  it('have no span, so a redact check on one blocks the call', async () => {
    const { run } = setup([{ id: 'pic', detect: readsImages().detect, action: 'redact' }]);

    const result = await run([image('AAAA')]);

    expect(result.blocked).toEqual({ check: 'pic', label: 'pic', failed: false });
    expect(result.report.checks.pic).toMatchObject({ found: 1, unredactable: 1 });
  });

  it('cannot have offsets: a detector that gives one is an error', async () => {
    const lying = Object.assign(() => [{ segment: 0, label: 'pic', start: 0, end: 2 }], {
      images: true as const,
    });
    const { run } = setup([{ id: 'pic', detect: lying, action: 'block' }]);

    const result = await run([image('AAAA')]);

    expect(result.blocked).toMatchObject({ check: 'pic', failed: true });
    expect(result.report.errors).toEqual([{ check: 'pic', name: 'TypeError' }]);
  });

  it('are left unread when the detector says so, and that finds nothing', async () => {
    const covered = new Set<number>();
    const refusing = Object.assign(() => [{ segment: 0, unscanned: true as const }], {
      images: true as const,
    });
    const { run } = setup([{ id: 'pic', detect: refusing, action: 'block' }]);

    const result = await run([image('AAAA')], { covered });

    expect(result.blocked).toBeUndefined();
    expect(result.report.checks.pic).toMatchObject({ found: 0 });
    expect(covered.size).toBe(0);
  });

  it('cannot be marked unscanned on a text: that is an error, not a way to skip it', async () => {
    const hiding = Object.assign(() => [{ segment: 0, unscanned: true as const }], {
      images: true as const,
    });
    const { run } = setup([{ id: 'pic', detect: hiding, action: 'block' }]);

    const result = await run([user('some text')]);

    expect(result.blocked).toMatchObject({ check: 'pic', failed: true });
    expect(result.report.errors).toEqual([{ check: 'pic', name: 'TypeError' }]);
  });

  it('are rejected as a detector config that is not a capability', async () => {
    const { compile } = await import('../../../../src/internal/options/compile.utils.js');
    const detect = Object.assign(() => [], { images: 'yes' });
    expect(() => compile({ version: 'v', checks: [{ id: 'a', detect: detect as never }] })).toThrow(
      /checks\[0\]\.detect\.images must be true/,
    );
  });
});

describe('detectors that are given the call', () => {
  const view = { input: [user('what is the balance')], meta: undefined };

  it('get it as the third argument, and others get none', async () => {
    const withCall = vi.fn<Detector>(() => []);
    Object.assign(withCall, { callView: true as const });
    const plain = vi.fn<Detector>(() => []);
    const { run } = setup([
      { id: 'a', detect: withCall },
      { id: 'b', detect: plain },
    ]);

    await run([user('x')], { call: view });

    expect(withCall.mock.calls[0]![2]).toBe(view);
    expect(plain.mock.calls[0]).toHaveLength(2);
  });

  it('are given nothing when the scan has no call, as for a request', async () => {
    const withCall = vi.fn<Detector>(() => []);
    Object.assign(withCall, { callView: true as const });
    const { run } = setup([{ id: 'a', detect: withCall }]);

    await run([user('x')]);

    expect(withCall.mock.calls[0]![2]).toBeUndefined();
  });
});
