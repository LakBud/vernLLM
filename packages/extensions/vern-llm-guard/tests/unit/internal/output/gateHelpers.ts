import { compile } from '../../../../src/internal/options/compile.utils.js';
import { gateStream } from '../../../../src/internal/output/streamGate.js';
import { createMemo } from '../../../../src/internal/scan/memo.utils.js';
import { createTokenMap } from '../../../../src/internal/tokens/tokens.js';

import type { Check, Detector, GuardOptions } from '../../../../src/index.js';
import type { StreamDone } from '../../../../src/internal/output/types.js';
import type { CallCache } from '../../../../src/internal/scan/types.js';
import type { StreamChunk } from 'vern-llm';

export const key = Buffer.alloc(32, 3);

export const find =
  (needle: string): Detector =>
  (segments) =>
    segments.flatMap((segment, index) => {
      const at = segment.text.indexOf(needle);
      return at === -1 ? [] : [{ segment: index, start: at, end: at + needle.length }];
    });

export const block = (needle: string, extra: Partial<Check> = {}): Check => ({
  id: 'block',
  detect: find(needle),
  action: 'block',
  on: 'output',
  ...extra,
});

export function setup(options: Partial<GuardOptions> & Pick<GuardOptions, 'checks'>) {
  const compiled = compile({ version: 'v1', ...options });
  const tokens = createTokenMap();
  const cache: CallCache = new Map();
  const deps = { memo: createMemo(100), ctx: { context: undefined, streaming: true } };
  return { compiled, tokens, cache, deps };
}

/**
 * A source that yields the chunks, and says whether it was left before its end. Its `finalResult`
 * settles once the chunks are drained, as a provider's does, or at once with `early`.
 */
export function source(chunks: StreamChunk[], final: unknown = undefined, early = false) {
  const state = { left: false, yielded: 0 };
  const text = chunks.map((c) => (c.type === 'text-delta' ? c.delta : '')).join('');
  let settle: (value: unknown) => void = () => {};
  const finalResult = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  if (early) settle(final ?? text);

  return {
    state,
    chunks: (async function* () {
      try {
        for (const chunk of chunks) {
          state.yielded++;
          yield chunk;
        }
        settle(final ?? text);
      } finally {
        state.left = true;
      }
    })(),
    finalResult,
  };
}

export const deltas = (...parts: string[]): StreamChunk[] =>
  parts.map((delta) => ({ type: 'text-delta', delta }));

export function run(
  setupResult: ReturnType<typeof setup>,
  src: ReturnType<typeof source>,
  json = false,
) {
  const done: StreamDone[] = [];
  const gated = gateStream({
    ...setupResult,
    source: src,
    json,
    onDone: (value) => done.push(value),
  });
  const drain = async () => {
    const seen: StreamChunk[] = [];
    let error: unknown;
    try {
      for await (const chunk of gated.chunks) seen.push(chunk);
    } catch (caught) {
      error = caught;
    }
    const final = await gated.finalResult.then(
      (value) => ({ value }),
      (reason: unknown) => ({ error: reason }),
    );
    const text = seen.map((c) => (c.type === 'text-delta' ? c.delta : '')).join('');
    return { seen, text, error, final };
  };
  return { done, drain, gated };
}

export const long = 'a'.repeat(40);

/** A memo that works until `after` lookups have been made, then throws, as a broken store would. */
export function failingMemo(after: number) {
  let lookups = 0;
  return {
    get: () => {
      if (++lookups > after) throw new Error('memo down');
      return undefined;
    },
    set: () => {},
    size: 0,
  } as never;
}
