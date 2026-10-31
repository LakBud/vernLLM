import type { Memo, Span } from './types.js';

/** A least recently used map of findings, or nothing when the cache is off. */
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
      if (entries.size > max) entries.delete(entries.keys().next().value!);
    },
  };
}

const encoder = new TextEncoder();

/**
 * What a text is remembered by: a hash of its source and text, so the cache never holds the text.
 * Web Crypto rather than `node:crypto`, so it also runs on edge runtimes.
 */
export async function segmentKey(source: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${source}\u0000${text}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
