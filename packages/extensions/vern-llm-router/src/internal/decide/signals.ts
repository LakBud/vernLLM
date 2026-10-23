import type { TargetSignals } from '../../types/index.js';

/** What the router knows about one candidate. `decide` reads it and imports nothing else. */
export type Signals = TargetSignals;

export const HEALTHY: Signals = { limited: false, warmingFactor: 1, inFlight: 0 };
