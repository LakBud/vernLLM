import { createStateKey, type PreDispatchContext } from 'vern-llm';

/** The call span's ids. */
export interface OtelSpanIds {
  traceId: string;
  spanId: string;
}

/**
 * Module level on purpose: the core rejects two otel instances on one `VernLLM`, so there is only
 * ever one writer, and `otelLogFields` can read it without being handed the instance.
 */
export const otelSpanIdsKey = createStateKey<OtelSpanIds>('otel.spanIds');

/**
 * The call span's `traceId` and `spanId`, for a log record to carry, or `{}` when this call has
 * no valid span. Call it with the context a middleware receives:
 *
 * ```ts
 * const ids = otelLogFields(ctx);
 * ```
 *
 * Works with either middleware registered first. The ids travel in `ctx.state`, so a middleware
 * that reads them does not need to import this package's instance.
 */
export function otelLogFields(ctx: PreDispatchContext): Partial<OtelSpanIds> {
  const ids = ctx.state.get(otelSpanIdsKey);
  return ids ? { traceId: ids.traceId, spanId: ids.spanId } : {};
}
