/** A circuit's key: `prefix`, or `prefix:model` with isolateByModel. No model keeps the bare `prefix`. */
export function bucketKey(
  prefix: string,
  isolateByModel: boolean,
  model: string | undefined,
): string {
  return isolateByModel && model !== undefined ? `${prefix}:${model}` : prefix;
}

/** The model a key belongs to, or undefined for the bare prefix. */
export function modelFromKey(
  key: string,
  prefix: string,
  isolateByModel: boolean,
): string | undefined {
  if (!isolateByModel || key === prefix) return undefined;
  return key.slice(prefix.length + 1);
}

/** Escapes SCAN glob characters. */
export function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, '\\$&');
}
