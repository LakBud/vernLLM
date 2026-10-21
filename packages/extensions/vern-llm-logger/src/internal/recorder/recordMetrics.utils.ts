/** Milliseconds to the microsecond: raw clock floats are noise in a log line. */
export const roundMs = (value: number): number => Math.round(value * 1000) / 1000;

/** `completionTokens` per second of the attempt, or `undefined` without both. */
export function outputTokensPerSec(
  completionTokens: number | undefined,
  attemptMs: number | undefined,
): number | undefined {
  if (completionTokens === undefined || attemptMs === undefined) return undefined;
  if (!Number.isFinite(completionTokens) || completionTokens <= 0 || attemptMs <= 0) {
    return undefined;
  }
  return roundMs(completionTokens / (attemptMs / 1000));
}
