import type {
  Decision,
  PolicyCrossJoinEvent,
  PolicyDecisionEvent,
  PolicyEventError,
} from '../../types/decision.js';

/** A decision as an event: ids and names only, never a `context` value. Shape version `1`. */
/** Rule and kind of error only, since a message may hold call data. */
function eventErrors(decision: Decision): PolicyEventError[] {
  const seen = new Set<string>();
  const errors: PolicyEventError[] = [];
  for (const { rule, name } of decision.errors) {
    const key = `${rule ?? ''}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ ...(rule !== undefined && { rule }), name });
  }
  return errors;
}

export function decisionEvent(decision: Decision): PolicyDecisionEvent {
  return {
    v: 1,
    ...(decision.version !== undefined && { version: decision.version }),
    outcome: decision.outcome,
    removed: decision.removed,
    audit: decision.audit,
    errors: eventErrors(decision),
    flags: decision.flagCauses,
    exceptions: decision.exceptions,
    ...(decision.labels !== undefined && { labels: decision.labels }),
  };
}

export function crossJoinEvent(
  version: string | undefined,
  target: string,
  rule: string,
): PolicyCrossJoinEvent {
  return { v: 1, ...(version !== undefined && { version }), target, rule };
}
