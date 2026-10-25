import type { Memo, Span } from './types.js';

export function createMemo(max: number): Memo | undefined {
  if (max <= 0) return undefined;
  const entries = new Map<string, readonly Span[]>();

  return {
    get(key) {
      const spans = entries.get(key);
      if (spans !== undefined) {
        // Most recently used goes last.
        entries.delete(key);
        entries.set(key, spans);
      }
      return spans;
    },
    set(key, spans) {
      entries.delete(key);
      entries.set(key, spans);
      if (entries.size > max) {
        entries.delete(entries.keys().next().value!);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
