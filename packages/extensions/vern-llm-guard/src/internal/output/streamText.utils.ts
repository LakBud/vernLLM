import type { CheckError, OutputReport } from '../../types/index.js';

/** The text after a stream's last whitespace boundary at or before `limit`, as an index. */
export function boundaryBefore(text: string, from: number, limit: number): number {
  for (let index = limit; index > from; index--) {
    if (/\s/.test(text[index - 1]!)) return index;
  }
  return -1;
}

/** Where a token that has only started to arrive begins at the end of `text`, else its length. */
export function partialTokenStart(text: string): number {
  const match = /(?:\[[A-Z0-9_]*(?:_[0-9a-f]{0,64})?|x[0-9a-f]{0,64}(?:@[a-z.]{0,16})?)$/i.exec(
    text,
  );
  return match === null ? text.length : match.index;
}

/** Moves `point` back off the middle of a surrogate pair, but never to or before `floor`. */
export function notInPair(text: string, point: number, floor: number): number {
  const code = text.charCodeAt(point - 1);
  return code >= 0xd800 && code <= 0xdbff && point - 1 > floor ? point - 1 : point;
}

export function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index++;
  return index;
}

/** A check that failed on every chunk is one error in the result, not one per chunk. */
export function unique(errors: readonly CheckError[]): CheckError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const id = `${error.check ?? ''}\u0000${error.name}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export const emptyReport = (): OutputReport => ({
  checks: {},
  audit: {},
  errors: [],
  late: 0,
  restored: 0,
  unrestored: 0,
});
