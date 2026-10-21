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

/**
 * Serializes what `build` produces for a text budget, so the JSON as a whole, structure
 * included, stays within `maxLength`. When the first try overflows, the largest text budget
 * that fits is found by bisection. `undefined` when nothing fits, since a cut JSON string
 * would be invalid.
 */
export function stringifyWithin(
  maxLength: number,
  build: (textBudget: number) => unknown,
): string | undefined {
  const first = stringify(build(maxLength));
  if (first === undefined || first.length <= maxLength) return first;

  // The text can never use more than the whole overflowing JSON, so that bounds the search.
  // Bisection assumes a bigger budget never gives shorter JSON. Cut tool arguments break that
  // slightly, since they become a string instead of an object, so the result can be a little
  // smaller than possible. It is never over the limit, since only fitting JSON is kept.
  let low = 0;
  let high = Math.min(maxLength, first.length) - 1;
  let best: string | undefined;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const json = stringify(build(mid));
    if (json !== undefined && json.length <= maxLength) {
      best = json;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

/** `stringifyWithin` with one redaction cache shared by every rebuild. */
export function stringifyWithinRedacted(
  maxLength: number,
  build: (textBudget: number, redacted: Map<string, unknown>) => unknown,
): string | undefined {
  const redacted = new Map<string, unknown>();
  return stringifyWithin(maxLength, (budget) => build(budget, redacted));
}
