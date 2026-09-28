import type { LocalCircuitCache } from './localCache.utils.js';
import type { CircuitState } from 'vern-llm';

/** A state change to report through onStateChange. */
export interface Change {
  from: CircuitState;
  to: CircuitState;
  failures: number;
}

/** What one reply, message or live read says about a bucket. */
export interface Observation {
  /** The state Redis left, when the observation is the change itself. */
  from?: CircuitState;
  state: CircuitState;
  failures: number;
  openedAt: number;
  version: number;
  timing?: { serverNow: number; cooldownMs: number; slots: number; grantAt: number };
  breakdown?: Record<string, number>;
  /** The half-open epoch, if carried. */
  epoch?: string;
  /** Set only on this process's own winning reply. */
  wonToken?: string;
}

/**
 * Applies an observation and returns the change to report, if any, so each
 * change is reported once per process. An older version is dropped unless
 * `force`, for a live read of a key Redis no longer has.
 */
export function applyObservation(
  local: LocalCircuitCache,
  key: string,
  observed: Observation,
  force = false,
): Change | undefined {
  const prior = local.get(key);
  if (!force && observed.version < prior.version) return undefined;

  const halfOpen = observed.state === 'half-open';
  const won = observed.wonToken !== undefined;
  // Slots of an earlier epoch belong to an abandoned trial.
  const heldStillLive =
    halfOpen && (observed.epoch === undefined || observed.epoch === prior.trialToken);
  const held = heldStillLive ? prior.trialsHeld : 0;

  local.set(key, {
    state: observed.state,
    failures: observed.failures,
    openedAt: observed.openedAt,
    // Only this process's winning reply adds a slot, so nothing races it to zero.
    trialsHeld: !halfOpen
      ? 0
      : won
        ? // Slots of the same trial add up.
          (prior.trialToken === observed.wonToken ? prior.trialsHeld : 0) + 1
        : held,
    trialToken: won ? observed.wonToken! : heldStillLive ? prior.trialToken : '',
    breakdown: observed.breakdown ?? prior.breakdown,
    serverOffset: observed.timing ? observed.timing.serverNow - Date.now() : prior.serverOffset,
    cooldownMs: observed.timing?.cooldownMs ?? prior.cooldownMs,
    slots: observed.timing?.slots ?? prior.slots,
    grantAt: observed.timing?.grantAt ?? prior.grantAt,
    version: Math.max(prior.version, observed.version),
  });

  // Only a newer version is news.
  if (!force && observed.version <= prior.version) return undefined;

  // Redis's from for the change itself, else catch up from what was known.
  const from =
    observed.from !== undefined && observed.from !== observed.state ? observed.from : prior.state;
  return from === observed.state
    ? undefined
    : { from, to: observed.state, failures: observed.failures };
}
