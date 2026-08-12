import { CircuitBreaker } from '../circuitBreaker.js';

import type { Logger } from '../logger.js';
import type { VernLLMEvent } from '../types/events.js';
import type { VernLLMOptions } from '../types/options.js';

/**
 * Builds the optional circuit breaker for one provider target, wiring its
 * `onStateChange` to emit a `circuit_state` event and chain any
 * caller-supplied `onStateChange`. Returns `undefined` when
 * `options.circuitBreaker` is falsy, matching the option's own semantics.
 *
 * Lives outside `CallExecutor` (and outside `VernLLM`, once this were
 * inlined) because the breaker has to exist *before* the executor it's
 * passed into, so its construction can't be an executor concern.
 * `onEvent` is called directly rather than through the executor for the
 * same reason: nothing executor-shaped exists yet at this point.
 */
export function buildCircuitBreaker(
  options: VernLLMOptions,
  providerName: string,
  logger: Logger,
): CircuitBreaker | undefined {
  if (!options.circuitBreaker) return undefined;

  const breakerOptions =
    typeof options.circuitBreaker === 'object' ? options.circuitBreaker : undefined;
  const userOnStateChange = breakerOptions?.onStateChange;

  const reportEvent = (event: VernLLMEvent) => {
    if (!options.onEvent) return;

    try {
      options.onEvent(event);
    } catch (error) {
      logger.error('[VernLLM] onEvent failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  return new CircuitBreaker({
    ...breakerOptions,
    onStateChange: (from, to, consecutiveFailures, model) => {
      reportEvent({
        kind: 'circuit_state',
        provider: providerName,
        model: model ?? options.model,
        from,
        to,
        consecutiveFailures,
      });

      // A caller-supplied onStateChange would otherwise be silently
      // discarded, since the spread above is overwritten by this
      // property. Chain it instead, same try/catch treatment as every
      // other user-supplied callback so it can't break breaker
      // bookkeeping or the call that triggered it.
      if (!userOnStateChange) return;

      try {
        userOnStateChange(from, to, consecutiveFailures, model);
      } catch (error) {
        logger.error('[VernLLM] circuitBreaker.onStateChange failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    },
  });
}
