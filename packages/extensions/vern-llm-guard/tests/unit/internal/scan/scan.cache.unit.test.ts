import { describe, expect, it } from 'vitest';

import { compile } from '../../../../src/internal/options/compile.utils.js';
import { createMemo } from '../../../../src/internal/scan/memo.utils.js';
import { scan } from '../../../../src/internal/scan/scan.js';
import { finds, image, later, readsImages, setup, tool, user } from './scanHelpers.js';

import type { Detector } from '../../../../src/index.js';
import type { CallCache, Memo, Span } from '../../../../src/internal/scan/types.js';

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

describe('images in the memo', () => {
  const deps = (memo: Memo | undefined) => ({
    memo,
    ctx: { context: undefined, streaming: false },
  });

  it('are remembered by a hash of their data, so one that comes back is read once', async () => {
    const pictures = readsImages();
    const { compiled, memo } = setup([{ id: 'pic', detect: pictures.detect }]);

    await scan(compiled, [image('AAAA')], new Map(), deps(memo));
    const again = await scan(compiled, [image('AAAA'), image('BBBB')], new Map(), deps(memo));

    expect(pictures.calls).toHaveLength(2);
    expect(pictures.calls[1]).toEqual([image('BBBB')]);
    expect(again.report.checks.pic).toMatchObject({ found: 2, memo: 1 });
  });

  it('are told apart by source, and from a text that happens to match', async () => {
    const pictures = readsImages();
    const { compiled, memo } = setup([
      { id: 'pic', detect: pictures.detect, on: ['user', 'tool'] },
    ]);

    await scan(compiled, [image('AAAA', 'user')], new Map(), deps(memo));
    await scan(compiled, [image('AAAA', 'tool')], new Map(), deps(memo));
    await scan(compiled, [user('AAAA')], new Map(), deps(memo));

    expect(pictures.calls).toHaveLength(3);
  });

  it('keep what an unreadable image said, so asking again does not change the count', async () => {
    const refusing = Object.assign(() => [{ segment: 0, unscanned: true as const }], {
      images: true as const,
    });
    const { compiled, memo } = setup([{ id: 'pic', detect: refusing }]);
    const covered = new Set<number>();

    await scan(compiled, [image('AAAA')], new Map(), { ...deps(memo), covered });
    await scan(compiled, [image('AAAA')], new Map(), { ...deps(memo), covered });

    expect(covered.size).toBe(0);
  });
});

describe('detectors that are given the call', () => {
  it('are never answered from the call cache or the memo, and write to neither', async () => {
    const detector = finds('x');
    Object.assign(detector.detect, { callView: true as const });
    const { compiled, memo } = setup([{ id: 'a', detect: detector.detect }]);
    const cache: CallCache = new Map();
    const deps = { memo, ctx: { context: undefined, streaming: false } };

    const first = await scan(compiled, [user('x')], cache, deps);
    const second = await scan(compiled, [user('x')], cache, deps);

    expect(detector.calls).toHaveLength(2);
    expect(cache.size).toBe(0);
    expect(memo!.size).toBe(0);
    expect(first.report.checks.a).not.toHaveProperty('memo');
    expect(second.report.checks.a).toMatchObject({ found: 1 });
  });
});
