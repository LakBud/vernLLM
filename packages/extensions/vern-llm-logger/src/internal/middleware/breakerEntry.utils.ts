import type { BreakerEntry, LogLevel } from '../../types/index.js';

/** The circuit state event, as far as an entry needs it. */
interface CircuitStateEvent {
  provider: string;
  model: string;
  from: string;
  to: string;
  consecutiveFailures: number;
}

/** A breaker change outside any call has no record to join, so it is written on its own. */
export function toBreakerEntry(event: CircuitStateEvent): { entry: BreakerEntry; level: LogLevel } {
  return {
    entry: {
      kind: 'breaker',
      v: 1,
      provider: event.provider,
      model: event.model,
      from: event.from,
      to: event.to,
      consecutiveFailures: event.consecutiveFailures,
    },
    level: event.to === 'open' ? 'warn' : 'info',
  };
}
