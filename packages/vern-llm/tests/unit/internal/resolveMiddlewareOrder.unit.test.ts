import { describe, expect, it, vi } from 'vitest';

import {
  buildMiddlewarePipeline,
  resolveMiddlewareOrder,
} from '../../../src/internal/resolveMiddlewareOrder.js';

import type { VernLLMMiddleware } from '../../../src/types/index.js';

function mw(overrides: Partial<VernLLMMiddleware> = {}): VernLLMMiddleware {
  return { ...overrides };
}

describe('resolveMiddlewareOrder', () => {
  it('returns entries unchanged when there are 0 or 1 of them', () => {
    expect(resolveMiddlewareOrder([])).toEqual([]);
    const single = [mw({ name: 'only' })];
    expect(resolveMiddlewareOrder(single)).toEqual(single);
  });

  it('sorts by priority ascending, ties broken by original array order, when no edges are present', () => {
    const noPriority = mw({ name: 'no-priority' });
    const low = mw({ name: 'low', priority: 1 });
    const high = mw({ name: 'high', priority: 10 });
    const zero = mw({ name: 'zero', priority: 0 });

    const result = resolveMiddlewareOrder([noPriority, low, high, zero]);

    // `no-priority` and `zero` both resolve to priority 0, so array
    // order breaks the tie between them.
    expect(result).toEqual([noPriority, zero, low, high]);
  });

  it('resolves runsAfter into the same order the equivalent runsBefore graph produces', () => {
    const a = mw({ name: 'a' });
    const b = mw({ name: 'b', runsAfter: ['a'] });
    const c = mw({ name: 'c', runsAfter: ['b'] });

    const viaRunsAfter = resolveMiddlewareOrder([c, a, b]);
    expect(viaRunsAfter.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);

    const a2 = mw({ name: 'a', runsBefore: ['b'] });
    const b2 = mw({ name: 'b', runsBefore: ['c'] });
    const c2 = mw({ name: 'c' });

    const viaRunsBefore = resolveMiddlewareOrder([c2, a2, b2]);
    expect(viaRunsBefore.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
  });

  it('resolves a diamond shaped dependency', () => {
    // top -> { left, right } -> bottom
    const top = mw({ name: 'top' });
    const left = mw({ name: 'left', runsAfter: ['top'], runsBefore: ['bottom'] });
    const right = mw({ name: 'right', runsAfter: ['top'], runsBefore: ['bottom'] });
    const bottom = mw({ name: 'bottom' });

    const result = resolveMiddlewareOrder([bottom, right, top, left]).map((entry) => entry.name);

    expect(result[0]).toBe('top');
    expect(result[3]).toBe('bottom');
    expect(new Set(result.slice(1, 3))).toEqual(new Set(['left', 'right']));
  });

  it('breaks ties among unconstrained nodes by priority, then original index', () => {
    const a = mw({ name: 'a', priority: 5 });
    const b = mw({ name: 'b', priority: 1, runsAfter: ['a'] });
    const c = mw({ name: 'c', priority: 2 });
    const d = mw({ name: 'd', priority: 2 });

    // b must run after a. Among the rest (a, c, d) with no edges between
    // them, priority (then original index) decides: c and d (priority
    // 2) both come before a (priority 5), tied by original index.
    const result = resolveMiddlewareOrder([b, a, c, d]).map((entry) => entry.name);
    expect(result).toEqual(['c', 'd', 'a', 'b']);
  });

  it('throws on a single self-referencing entry instead of bypassing validation', () => {
    const single = [mw({ name: 'solo', runsAfter: ['solo'] })];
    expect(() => resolveMiddlewareOrder(single)).toThrow(/cycle/);
  });

  it('warns on a single entry referencing an unknown name instead of bypassing validation', () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const single = [mw({ name: 'solo', runsAfter: ['missing'] })];
    expect(resolveMiddlewareOrder(single, logger)).toEqual(single);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('throws on duplicate explicit names', () => {
    const entries = [mw({ name: 'dup' }), mw({ name: 'dup' })];
    expect(() => resolveMiddlewareOrder(entries)).toThrow(/duplicate name/);
  });

  it("throws when an unnamed entry's index label collides with an explicit name", () => {
    const entries = [mw({ name: '1' }), mw()];
    expect(() => resolveMiddlewareOrder(entries)).toThrow(/duplicate name/);
  });

  it('warns once and drops an unknown runsAfter/runsBefore reference instead of erroring', () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const a = mw({ name: 'a', runsAfter: ['does-not-exist'] });
    const b = mw({ name: 'b' });

    const result = resolveMiddlewareOrder([a, b], logger);

    expect(result.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does-not-exist'));
  });

  it('throws a plain Error (not LLMError) on a cycle of two', () => {
    const a = mw({ name: 'a', runsAfter: ['b'] });
    const b = mw({ name: 'b', runsAfter: ['a'] });

    expect(() => resolveMiddlewareOrder([a, b])).toThrow(/cycle/);
    try {
      resolveMiddlewareOrder([a, b]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('Error');
    }
  });

  it('throws on a cycle of three', () => {
    const a = mw({ name: 'a', runsAfter: ['c'] });
    const b = mw({ name: 'b', runsAfter: ['a'] });
    const c = mw({ name: 'c', runsAfter: ['b'] });

    expect(() => resolveMiddlewareOrder([a, b, c])).toThrow(/cycle/);
  });

  it('does not throw on a self-referencing runsBefore-only graph with no actual cycle', () => {
    const a = mw({ name: 'a' });
    const b = mw({ name: 'b', runsBefore: ['a'] });

    expect(() => resolveMiddlewareOrder([a, b])).not.toThrow();
  });
});

describe('buildMiddlewarePipeline', () => {
  it('makes wrapOrder equal transformOrder when nothing sets position', () => {
    const middleware = [mw({ name: 'a', priority: 2 }), mw({ name: 'b', priority: 1 })];
    const pipeline = buildMiddlewarePipeline(middleware);

    expect(pipeline.wrapOrder).toEqual(pipeline.transformOrder);
    expect(pipeline.transformOrder.map((entry) => entry.name)).toEqual(['b', 'a']);
  });

  it('reflects the resolved order in names, frozen', () => {
    const middleware = [mw({ name: 'second', priority: 1 }), mw({ name: 'first', priority: 0 })];
    const pipeline = buildMiddlewarePipeline(middleware);

    expect(pipeline.names).toEqual(['first', 'second']);
    expect(Object.isFrozen(pipeline.names)).toBe(true);
  });

  it('falls back to a bracket-free string index for an unnamed entry', () => {
    const middleware = [mw({ priority: 1 }), mw({ name: 'named', priority: 0 })];
    const pipeline = buildMiddlewarePipeline(middleware);

    expect(pipeline.names).toEqual(['named', '1']);
  });

  describe('position (wrapOrder only)', () => {
    it('keeps a single pinned entry at its edge as more unrelated middleware are added around it', () => {
      for (const size of [2, 4, 8]) {
        const pinned = mw({ name: 'pinned', position: 'outermost' });
        const rest = Array.from({ length: size }, (_, i) => mw({ name: `mw-${i}` }));
        const pipeline = buildMiddlewarePipeline([...rest, pinned]);

        expect(pipeline.wrapOrder[0]!.name).toBe('pinned');
      }
    });

    it('resolves two outermost claimants by registration order', () => {
      const first = mw({ name: 'first', position: 'outermost' });
      const second = mw({ name: 'second', position: 'outermost' });
      const other = mw({ name: 'other' });

      const pipeline = buildMiddlewarePipeline([other, first, second]);

      expect(pipeline.wrapOrder.map((entry) => entry.name)).toEqual(['first', 'second', 'other']);
    });

    it('lets a numeric position behave like priority, for wrapOrder only', () => {
      const a = mw({ name: 'a' });
      const b = mw({ name: 'b', position: -5 });
      const c = mw({ name: 'c' });

      const pipeline = buildMiddlewarePipeline([a, b, c]);

      expect(pipeline.wrapOrder.map((entry) => entry.name)).toEqual(['b', 'a', 'c']);
      // transformOrder is untouched by any position value.
      expect(pipeline.transformOrder.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
    });

    it('leaves transformOrder untouched by any position value', () => {
      const a = mw({ name: 'a', position: 'innermost' });
      const b = mw({ name: 'b', position: 'outermost' });
      const c = mw({ name: 'c' });

      const pipeline = buildMiddlewarePipeline([a, b, c]);

      expect(pipeline.transformOrder.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
      expect(pipeline.wrapOrder.map((entry) => entry.name)).toEqual(['b', 'c', 'a']);
    });
  });
});
