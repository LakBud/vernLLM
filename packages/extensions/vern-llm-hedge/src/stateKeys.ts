import { createStateKey } from 'vern-llm';

import type { HedgeDecisionEvent } from './types/index.js';

/**
 * Module level on purpose: the hedge writes it and `hedgeLogFields` reads it without being handed
 * the instance, the way the other extensions' fields travel.
 */
export const hedgeDecisionKey = createStateKey<HedgeDecisionEvent>('hedge.decision');
