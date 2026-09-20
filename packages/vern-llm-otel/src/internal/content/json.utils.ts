export function stringify(value: unknown): string | undefined {
  try {
    // Undefined for a value JSON cannot represent, and a throw for a cycle or a BigInt.
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Tool arguments arrive as a JSON string. Structured when it parses, the string otherwise. */
export function toArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function isNonEmpty(text: string | undefined): text is string {
  return text !== undefined && text !== '';
}
