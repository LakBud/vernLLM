import { evaluate } from '../evaluate/evaluate.js';
import { redactText } from '../evaluate/redactText.js';
import { invalid } from '../options/invalid.utils.js';
import { createLive, type Live } from './live.js';

import type { GuardMiddleware, GuardOptions } from '../../types/index.js';

export function createEvaluate(getLive: () => Live): GuardMiddleware['evaluate'] {
  return (input) => {
    const { compiled, memo } = getLive();
    return evaluate(compiled, memo, input);
  };
}

export function createUpdate(
  getLive: () => Live,
  setLive: (next: Live) => void,
): GuardMiddleware['update'] {
  return (update) => {
    const live = getLive();
    if (typeof update !== 'object' || update === null) invalid('update must be an object');
    // A result names the checks it ran, so two sets must not share a name.
    if (update.version === live.options.version) {
      invalid(`update version must differ from the current one ("${update.version}")`);
    }

    // Compiled completely before anything is swapped, so a bad update changes nothing. The memo
    // starts empty: findings are keyed by version, so none of the old ones can apply.
    const merged: GuardOptions = {
      ...live.options,
      version: update.version,
      checks: update.checks,
      ...(update.stream !== undefined && {
        stream: { ...live.options.stream, ...update.stream },
      }),
    };
    setLive(createLive(merged, live));
  };
}

export function createRedactText(getLive: () => Live): GuardMiddleware['redactText'] {
  return (text) => {
    const { compiled, guard } = getLive();
    try {
      return redactText(compiled, text);
    } catch (error) {
      guard.report('redactText', error);
      // It cannot be said what is in the text, so none of it is shown. A fixed text, because a
      // mask that throws is the one way to get here.
      return '[REDACTED]';
    }
  };
}
