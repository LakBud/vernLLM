import { createHmac } from 'node:crypto';

/** What a token stands for. */
interface TokenEntry {
  value: string;
  /** Set for a check with `restore: false`: the text that stands in for the value, always. */
  mask?: string;
}

/**
 * The tokens of one call. There is no vault: the map is built from the call's own request, lives
 * as long as the call, and holds the only copy of the values.
 */
export interface TokenMap {
  /** By lowercased token, since a model may change the case. */
  readonly entries: Map<string, TokenEntry>;
  /** Token by label and value, so one value has one token. */
  readonly byValue: Map<string, string>;
  /** Value to token, for turning raw echoes into tokens. */
  readonly values: Map<string, string>;
  /** Built from `values`, and dropped when it changes. */
  echoPattern?: RegExp | undefined;
}

export function createTokenMap(): TokenMap {
  return { entries: new Map(), byValue: new Map(), values: new Map() };
}

/** Where a token can be in text. Hash lengths grow past the base only on a collision. */
const TOKEN_PATTERN = /x[0-9a-f]{6,64}@redacted\.invalid|\[[A-Z0-9_]+_[0-9a-f]{4,64}\]/gi;

const EMAIL_HEX = 6;
const OTHER_HEX = 4;
const MAX_HEX = 64;

function format(label: string, hex: string): string {
  return label === 'email'
    ? `x${hex}@redacted.invalid`
    : `[${label.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_${hex}]`;
}

/** A token that no other value in the map has, longer only when a shorter one is taken. */
function makeToken(map: TokenMap, key: Uint8Array, label: string, value: string): string {
  const hex = createHmac('sha256', key).update(label).update('\u0000').update(value).digest('hex');

  // Two values that collide in a short hash get a longer one, for this call.
  for (let length = label === 'email' ? EMAIL_HEX : OTHER_HEX; length < MAX_HEX; length += 2) {
    const candidate = format(label, hex.slice(0, length));
    const taken = map.entries.get(candidate.toLowerCase());
    if (taken === undefined || taken.value === value) return candidate;
  }
  // The whole hash is as long as it gets, and cannot collide.
  return format(label, hex);
}

/** Records what a token stands for. Masking wins: one check that never lets a value out is enough. */
function remember(map: TokenMap, token: string, value: string, mask: string | undefined): void {
  const entry = map.entries.get(token.toLowerCase());
  if (entry === undefined) {
    map.entries.set(token.toLowerCase(), { value, ...(mask !== undefined && { mask }) });
  } else if (mask !== undefined) {
    entry.mask = mask;
  }
}

/**
 * The token for `value`: a keyed hash of its label and the value, so the same value has the same
 * token in a call and across turns, and no other process can tell what it stands for. An email
 * keeps the form of an address, on a domain reserved for what is not real, so validators that
 * expect one still pass. `mask` makes the token restore as that text instead of the value.
 */
export function tokenFor(
  map: TokenMap,
  key: Uint8Array,
  label: string,
  value: string,
  mask?: string,
): string {
  const lookup = `${label}\u0000${value}`;
  let token = map.byValue.get(lookup);

  if (token === undefined) {
    token = makeToken(map, key, label, value);
    map.byValue.set(lookup, token);
    if (!map.values.has(value)) {
      map.values.set(value, token);
      map.echoPattern = undefined;
    }
  }

  remember(map, token, value, mask);
  return token;
}

function escapePattern(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Turns raw values the request held into their tokens. A target that was given the raw text may
 * echo it, and after this its answer looks like any other target's.
 */
export function tokenizeKnown(text: string, map: TokenMap): string {
  if (map.values.size === 0) return text;

  map.echoPattern ??= new RegExp(
    // Longest first, so a value that holds another is replaced whole.
    [...map.values.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapePattern)
      .join('|'),
    'g',
  );
  return text.replace(map.echoPattern, (match) => map.values.get(match)!);
}

export interface Restored {
  text: string;
  /** Tokens turned back into values. */
  restored: number;
  /** Token shaped text that stands for nothing in this call. It is left as it is. */
  unrestored: number;
}

/**
 * Turns tokens back into the values they stood for, or the mask text for a check that never lets
 * a value out. Matching ignores case. Pass `json` when `text` is inside a JSON string, so a value
 * with a quote or a newline stays valid.
 */
export function restoreTokens(
  text: string,
  map: TokenMap,
  options: { json?: boolean } = {},
): Restored {
  let restored = 0;
  let unrestored = 0;

  const result = text.replace(TOKEN_PATTERN, (match) => {
    const entry = map.entries.get(match.toLowerCase());
    if (entry === undefined) {
      unrestored++;
      return match;
    }
    restored++;
    const replacement = entry.mask ?? entry.value;
    return options.json ? JSON.stringify(replacement).slice(1, -1) : replacement;
  });

  return { text: result, restored, unrestored };
}

/** Where this call's tokens are in `text`, as `[start, end)` pairs. */
export function tokenRanges(text: string, map: TokenMap): [number, number][] {
  if (map.entries.size === 0) return [];

  const ranges: [number, number][] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (map.entries.has(match[0].toLowerCase())) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}
