import type { Metrics } from '../metrics/metrics.utils.js';
import type { CallTracker } from './callTracker.js';
import type { MiddlewareContext, VernLLMEvent } from 'vern-llm';

/** The single event entry point: metrics first, so an event with no tracker still counts. */
export function handleEvent(
  event: VernLLMEvent,
  ctx: MiddlewareContext | undefined,
  tracker: CallTracker | undefined,
  metrics: Metrics,
): void {
  // A hand built context can predate `adapter`, so its absence is not an error.
  const adapterProvider = ctx?.stage === 'attempt' ? ctx.adapter?.provider : undefined;
  metrics.recordEvent(event, tracker?.measurementContext(), adapterProvider);
  tracker?.applyEvent(event);
}
