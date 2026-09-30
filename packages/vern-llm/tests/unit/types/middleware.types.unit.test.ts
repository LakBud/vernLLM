import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createMiddlewareRef,
  createMiddlewareStateBag,
  createStateKey,
  stateEntry,
  type MiddlewareRef,
  type MiddlewareStateEntry,
  type MiddlewareStateKey,
  type PreDispatchContext,
  type VernLLMMiddleware,
} from '../../../src/types/middleware.js';

import type { AdapterInfo } from '../../../src/types/client.js';
import type { CallMeta, TargetInfo } from '../../../src/types/fallback.js';

// `MiddlewareRef` and `MiddlewareStateKey<T>` are structurally identical
// at runtime (both are just `{ debugName: string }`), but must stay
// nominally distinct at the type level: neither can substitute for the
// other, and neither can be faked with a plain object literal that
// skips `createMiddlewareRef`/`createStateKey`. This is a compile-time
// guarantee only; nothing here can fail at runtime, and the actual
// assertion is `pnpm typecheck:test` finding every `@ts-expect-error`
// below still necessary. If a future refactor drops the brand, these
// lines start compiling and `typecheck:test` fails on the now-unused
// `@ts-expect-error` directives, even though every runtime assertion in
// the rest of the suite would keep passing unchanged.

describe('MiddlewareRef / MiddlewareStateKey nominal typing', () => {
  it('a real ref and a real state key are usable as themselves', () => {
    const ref = createMiddlewareRef('auth');
    const key = createStateKey<string>('span-id');

    expect(ref.debugName).toBe('auth');
    expect(key.debugName).toBe('span-id');
  });

  it('rejects cross-assignment and plain-literal impersonation at compile time', () => {
    const ref = createMiddlewareRef('auth');
    const key = createStateKey<string>('span-id');

    // @ts-expect-error a MiddlewareRef cannot satisfy MiddlewareStateKey<T>
    const asStateKey: MiddlewareStateKey<string> = ref;
    // @ts-expect-error a MiddlewareStateKey<T> cannot satisfy MiddlewareRef
    const asRef: MiddlewareRef = key;
    // @ts-expect-error a plain object literal cannot satisfy MiddlewareRef
    const fakeRef: MiddlewareRef = { debugName: 'fake' };
    // @ts-expect-error a plain object literal cannot satisfy MiddlewareStateKey<T>
    const fakeKey: MiddlewareStateKey<string> = { debugName: 'fake' };

    void asStateKey;
    void asRef;
    void fakeRef;
    void fakeKey;
  });
});

describe('stateEntry and a seeded state bag', () => {
  it('stateEntry ties the value to the key type at compile time', () => {
    const key = createStateKey<string>('tenant');

    expectTypeOf(stateEntry(key, 't1')).toEqualTypeOf<MiddlewareStateEntry>();

    // @ts-expect-error a number cannot be stored under a MiddlewareStateKey<string>
    const mismatched = stateEntry(key, 1);

    void mismatched;
  });

  it('seeds the bag from entries, and later entries win', () => {
    const tenant = createStateKey<string>('tenant');
    const count = createStateKey<number>('count');
    const bag = createMiddlewareStateBag([
      stateEntry(tenant, 'first'),
      stateEntry(count, 2),
      stateEntry(tenant, 'last'),
    ]);

    expect(bag.get(tenant)).toBe('last');
    expect(bag.get(count)).toBe(2);
  });

  it('starts empty without entries, and stays writable when seeded', () => {
    const key = createStateKey<string>('tenant');

    expect(createMiddlewareStateBag().get(key)).toBeUndefined();
    expect(createMiddlewareStateBag([]).get(key)).toBeUndefined();

    const seeded = createMiddlewareStateBag([stateEntry(key, 'a')]);
    seeded.set(key, 'b');

    expect(seeded.get(key)).toBe('b');
  });
});

describe('target order types', () => {
  it('next() takes optional target names and resolves to a CallResult', () => {
    type Next = Parameters<NonNullable<VernLLMMiddleware['wrap']>>[1];

    expectTypeOf<Next>().parameter(0).toEqualTypeOf<{ targets?: readonly string[] } | undefined>();
    expectTypeOf<Next>().returns.resolves.toHaveProperty('value');
  });

  it('a wrap can call next() with no arguments, and a middleware written before targets still compiles', () => {
    const legacy: VernLLMMiddleware = { name: 'legacy', wrap: (_request, next) => next() };

    expect(legacy.name).toBe('legacy');
  });

  it('TargetInfo describes a target by name, declared index, model and adapter', () => {
    expectTypeOf<TargetInfo>().toEqualTypeOf<{
      name: string;
      index: number;
      model: string;
      adapter: AdapterInfo;
    }>();
  });

  it('ctx.targets is read only, so a wrap cannot reorder the order it was shown in place', () => {
    expectTypeOf<PreDispatchContext['targets']>().toEqualTypeOf<readonly TargetInfo[]>();
  });

  it('CallMeta carries the position in the order tried', () => {
    expectTypeOf<CallMeta['position']>().toEqualTypeOf<number>();
  });
});
