import { describe, expect, it } from 'vitest';

import {
  createMiddlewareRef,
  createStateKey,
  type MiddlewareRef,
  type MiddlewareStateKey,
} from '../../../src/types/middleware.js';

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
