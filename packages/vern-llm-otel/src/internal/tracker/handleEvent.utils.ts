import type { Metrics } from '../metrics/metrics.utils.js';
import type { CallTracker } from './callTracker.js';
import type { VernLLMEvent } from 'vern-llm';

/** The single event entry point: metrics first, so an event with no tracker still counts. */
export function handleEvent(
  event: VernLLMEvent,
  tracker: CallTracker | undefined,
  metrics: Metrics,
): void {
  metrics.recordEvent(event, tracker?.measurementContext());
  tracker?.applyEvent(event);
}
