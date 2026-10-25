import { describe, expect, it } from 'vitest';

import { compile } from '../../../../src/internal/options/compile.utils.js';
import { createMemo } from '../../../../src/internal/scan/memo.utils.js';
import { scan } from '../../../../src/internal/scan/scan.js';
import { finds, later, setup, tool, user } from './scanHelpers.js';

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
