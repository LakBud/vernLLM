/** Stringifies a value with object keys sorted, so identical values always serialize the same regardless of insertion order. */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }

  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((key) => {
    const entryValue = (value as Record<string, unknown>)[key];
    // Matches JSON.stringify's own behavior: a key whose value is
    // `undefined` is omitted entirely, not serialized as `"key":undefined`.
    if (entryValue === undefined) return undefined;
    return `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`;
  });

  return `{${entries.filter((entry) => entry !== undefined).join(',')}}`;
}

/** FNV-1a, 32 bit. Not cryptographic. Good enough distribution for a cache key, and stays synchronous. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hashes a built wire request into a stable cache key. Same request
 * (after defaults) always derives the same key; a change to any field
 * that affects what's sent changes the key too. Prefixed `wr_`.
 */
export function deriveCacheKeyFromRequest(preview: { model: string; request: unknown }): string {
  const canonical = canonicalStringify({ model: preview.model, request: preview.request });
  return `wr_${fnv1a(canonical)}`;
}
