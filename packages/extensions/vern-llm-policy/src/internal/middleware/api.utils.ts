import { evaluate } from '../evaluate/evaluate.js';
import { targetFacts } from '../facts/targetFacts.utils.js';
import { compile } from '../options/compile.utils.js';
import { invalid } from '../options/invalid.utils.js';
import { readEvaluateInput } from './evaluateInput.utils.js';
import { createLive, type Live } from './live.js';

import type { PolicyMiddleware, PolicyOptions } from '../../types/index.js';

/** `evaluate`: the decision for a call described as data, with no call made. */
export function createEvaluate(getLive: () => Live): PolicyMiddleware['evaluate'] {
  return (input) => {
    const { policy } = getLive();
    const { call, targets, now } = readEvaluateInput(policy, input, (info) =>
      targetFacts(policy, info),
    );
    return evaluate(policy, call, targets, now);
  };
}

/** `update`: compiled first, so a mistake throws and the old policy keeps running. */
export function createUpdate(
  logger: PolicyOptions['logger'],
  setLive: (live: Live) => void,
): PolicyMiddleware['update'] {
  return (update) => {
    const raw: unknown = update;
    if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'logger')) {
      invalid('update cannot change the logger');
    }
    setLive(createLive(compile({ ...update }), logger));
  };
}
