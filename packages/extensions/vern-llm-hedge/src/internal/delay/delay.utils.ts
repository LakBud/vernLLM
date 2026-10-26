import { bucketOfRequest, SIZE_DIMENSION } from '../size.utils.js';
import { StatsCache } from './statsCache.js';

import type { ResolvedConfig } from '../../types/index.js';
import type { Adapt } from '../adapt.js';
import type { Guard } from '../guard.utils.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/** How long to wait before hedging this call, or `undefined` when there is no basis for one. */
export interface Delay {
  for(ctx: PreDispatchContext, request: Readonly<WireCallRequest>): number | undefined;
}

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function createDelay(config: ResolvedConfig, guard: Guard, adapt?: Adapt): Delay {
  const { delay } = config;

  if (delay.kind === 'fixed') return { for: () => delay.ms };

  if (delay.kind === 'function') {
    return {
      for(ctx, request) {
        const ms = guard('delay', () => delay.fn(ctx, request), undefined);
        if (ms === undefined) return undefined;
        if (usable(ms)) return ms;
        guard.warnOnce(
          'delay-value',
          'delay returned a value that is not a positive, finite number',
        );
        return undefined;
      },
    };
  }

  const cache = new StatsCache(config.stats!, config.statsTtlMs);

  return {
    for(ctx, request) {
      const first = ctx.targets[0]?.name;
      if (first === undefined) return undefined;

      // The target's own series for this stream mode, narrowed to the prompt's size bucket when
      // the logger records `promptSizeDimension`. A bucket below `minSamples` reads as unknown.
      const mode = { provider: first, streaming: String(ctx.streaming === true) };
      const quantile = adapt ? adapt.quantileFor(first, delay.quantile) : delay.quantile;
      const now = Date.now();

      let learned: number | undefined;
      try {
        learned =
          cache.quantile({ ...mode, [SIZE_DIMENSION]: bucketOfRequest(request) }, quantile, now) ??
          cache.quantile(mode, quantile, now);
      } catch (error) {
        guard.warnOnce(
          'stats',
          `stats.quantile threw, so calls without a fallbackMs are not hedged: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const ms = usable(learned) ? learned : delay.fallbackMs;
      return ms === undefined ? undefined : Math.max(ms, delay.minMs);
    },
  };
}
