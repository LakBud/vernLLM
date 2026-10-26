import type { HedgeDeps } from './deps.js';
import type { MiddlewareContext, VernLLMEvent, VernLLMMiddleware } from 'vern-llm';

type OnEvent = NonNullable<VernLLMMiddleware['onEvent']>;

/**
 * The `onEvent` hook of cache awareness: a target that reports cache reads has this call's prefix
 * in its cache for a while. `undefined` when cache awareness is off, so no hook is registered.
 */
export function createCacheEvent({ cacheAware, guard, prefixKey }: HedgeDeps): OnEvent | undefined {
  if (!cacheAware) return undefined;

  return (event: VernLLMEvent, ctx: MiddlewareContext) =>
    guard(
      'cacheEvent',
      () => {
        if (event.kind !== 'usage' || !((event.usage.cacheReadTokens ?? 0) > 0)) return;
        const key = ctx.state.get(prefixKey);
        if (key !== undefined) {
          cacheAware.remember(event.usage.provider ?? 'primary', key, Date.now());
        }
      },
      undefined,
    );
}
