import { renewalInterval, type Heartbeats } from '../../shared/timing/heartbeat.utils.js';

import type { CircuitBreakerCallContext } from 'vern-llm';

interface Permit {
  key: string;
  token: string;
  stopHeartbeat: () => void;
}

/** The trial slots this process's calls are spending, keyed by each call's state bag. */
export interface Permits {
  /** Records the slot this call spends and renews its lease until the call ends. */
  grant(
    context: CircuitBreakerCallContext,
    key: string,
    model: string | undefined,
    token: string,
  ): void;
  /** Removes the call's permit for `key` and stops its renewal. */
  take(key: string, context: CircuitBreakerCallContext): Permit | undefined;
  /** The token an outcome presents: the permit's, '' without one, '*' without a context. */
  takeToken(key: string, context: CircuitBreakerCallContext | undefined): string;
}

export function createPermits(options: {
  heartbeats: Heartbeats;
  probeLeaseMs: number;
  renew: (model: string | undefined, token: string) => void;
}): Permits {
  const permits = new WeakMap<object, Permit>();

  function take(key: string, context: CircuitBreakerCallContext): Permit | undefined {
    const permit = permits.get(context.state);
    if (!permit || permit.key !== key) return undefined;

    permits.delete(context.state);
    permit.stopHeartbeat();
    return permit;
  }

  return {
    grant(context, key, model, token) {
      permits.set(context.state, {
        key,
        token,
        stopHeartbeat: options.heartbeats.start(
          () => options.renew(model, token),
          renewalInterval(options.probeLeaseMs),
        ),
      });
    },

    take,

    takeToken(key, context) {
      if (!context) return '*';
      return take(key, context)?.token ?? '';
    },
  };
}
