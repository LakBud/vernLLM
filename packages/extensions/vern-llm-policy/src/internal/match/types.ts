/** Tests facts against one compiled pattern. Facts are whatever the pattern was written for. */
export type Matcher = (facts: unknown) => boolean;

export interface MatcherOptions {
  /** Whether a key may hold a nested pattern, as `context` and `request` do in `when`. */
  nested: boolean;
}
