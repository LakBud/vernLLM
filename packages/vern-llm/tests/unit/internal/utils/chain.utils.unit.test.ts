import { describe, expect, it } from 'vitest';

import { chainFields, chainSignal } from '../../../../src/internal/utils/chain.utils.js';

describe('chainSignal', () => {
  it('aborts with its parent and with its own controller', () => {
    const parent = new AbortController();
    const own = new AbortController();
    const fromParent = chainSignal(parent.signal, own.signal, 1);
    const fromOwn = chainSignal(parent.signal, own.signal, 2);

    expect(fromParent.aborted).toBe(false);

    own.abort();
    expect(fromOwn.aborted).toBe(true);

    const second = new AbortController();
    const withParent = chainSignal(parent.signal, second.signal, 3);
    parent.abort();
    expect(withParent.aborted).toBe(true);
  });

  it('uses the chain own signal alone when the call has none', () => {
    const own = new AbortController();

    expect(chainSignal(undefined, own.signal, 1)).toBe(own.signal);
  });
});

describe('chainFields', () => {
  it('names the chain a signal was made for', () => {
    const signal = chainSignal(new AbortController().signal, new AbortController().signal, 3);

    expect(chainFields(signal)).toEqual({ chain: 3 });
  });

  it('is empty for the main chain, an unknown signal and no signal', () => {
    const main = chainSignal(new AbortController().signal, new AbortController().signal, 0);

    expect(chainFields(main)).toEqual({});
    expect(chainFields(new AbortController().signal)).toEqual({});
    expect(chainFields(undefined)).toEqual({});
  });
});
