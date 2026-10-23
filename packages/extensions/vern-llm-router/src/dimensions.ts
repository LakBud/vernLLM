import { ROUTER_DECISION_EVENT } from './routerMiddleware.js';

/** The part of the logger's call record these read, so no import of the logger is needed. */
interface DecisionRecord {
  provider?: string;
  custom?: Record<string, unknown[]>;
}

interface RecordedDecision {
  route?: unknown;
  strategy?: unknown;
  order?: unknown;
}

/** The call's last `router.decision`, which the logger keeps by default. */
function decisionOf(record: DecisionRecord): RecordedDecision | undefined {
  const events = record.custom?.[ROUTER_DECISION_EVENT];
  const last = events?.[events.length - 1];
  return typeof last === 'object' && last !== null ? (last as RecordedDecision) : undefined;
}

/**
 * The route that decided a call, as a logger dimension: `dimensions: { route: routeDimension }`
 * splits percentiles and quality rates by route. No matching route or no decision yields nothing.
 * The logger keeps `router.*` events by default, so no extra setup is needed.
 */
export const routeDimension = (record: DecisionRecord): string | undefined => {
  const route = decisionOf(record)?.route;
  return typeof route === 'string' && route !== '' ? route : undefined;
};

/**
 * `'yes'` when the target the router put first is not the one that answered. Applied, that means
 * the first choice failed and the chain fell back. In shadow mode it compares what the router
 * would have picked with what the declared order answered, which judges a rollout before it is
 * switched on. Pinned calls and calls with no decision yield nothing.
 */
export const driftDimension = (record: DecisionRecord): 'yes' | 'no' | undefined => {
  const decision = decisionOf(record);
  if (!decision || decision.strategy === 'pinned' || record.provider === undefined) {
    return undefined;
  }
  const first = Array.isArray(decision.order) ? decision.order[0] : undefined;
  if (typeof first !== 'string') return undefined;
  return first === record.provider ? 'no' : 'yes';
};
