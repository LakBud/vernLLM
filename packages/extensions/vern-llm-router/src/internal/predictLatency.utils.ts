import type { ResolvedRoute } from '../types/index.js';
import type { StatsCache } from './statsCache.js';
import type { WireCallRequest } from 'vern-llm';

/** The slow tail of generation speed, as the complementary quantile without float noise. */
const slowTail = (q: number): number => Math.round((1 - q) * 1e6) / 1e6;

/**
 * Time to first token plus the expected answer at the target's generation speed. Streamed data is
 * used for every call, since how a provider starts and generates does not depend on delivery.
 * `undefined` when there is no streamed start or speed, so the caller falls back to plain latency.
 */
export function predictLatency(
  stats: StatsCache,
  name: string,
  route: ResolvedRoute | undefined,
  request: Readonly<WireCallRequest>,
  q: number,
  now: number,
): number | undefined {
  const streamed = { provider: name, streaming: 'true' };
  const start = stats.quantile(streamed, q, 'attemptMs', now);
  const speed = stats.quantile(streamed, slowTail(q), 'outputTokensPerSec', now);
  if (start === undefined || speed === undefined || !(speed > 0)) return undefined;

  const typical = route
    ? stats.quantile({ route: route.name }, 0.5, 'outputTokens', now)
    : undefined;
  const expected = Math.min(
    typical !== undefined && typical > 0 ? typical : request.max_tokens,
    request.max_tokens,
  );
  return start + (expected / speed) * 1000;
}
