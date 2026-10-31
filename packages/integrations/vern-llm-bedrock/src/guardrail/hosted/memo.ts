import type { Input, Memo, Span } from './types.js';

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
  return digest(`${source}\u0000${text}`);
}

async function digest(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(content));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/**
 * What any input is remembered by. An image is keyed by a hash of its data, so one that comes back
 * in the history is read once. An answer judged against a call is keyed by the sources, the question
 * and the text together, since the verdict depends on all three. Neither kind can meet a text key,
 * which never starts with `[`.
 */
export async function inputKey(input: Input): Promise<string> {
  if ('image' in input) {
    const { data, mimeType } = input.image;
    return digest(JSON.stringify(['image', input.source, mimeType, data]));
  }
  if ('ground' in input) {
    const { sources, query } = input.ground;
    return digest(JSON.stringify(['ground', input.text, query ?? null, sources]));
  }
  return segmentKey(input.source, input.text);
}
