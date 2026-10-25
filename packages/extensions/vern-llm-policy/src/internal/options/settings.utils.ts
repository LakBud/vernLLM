import { invalid } from './invalid.utils.js';

import type { PolicyOptions } from '../../types/options.js';

/** The first choice is the default. */
function choice<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  const chosen = value ?? allowed[0];
  if (!allowed.includes(chosen as T)) {
    invalid(`${name} must be ${allowed.map((option) => `'${option}'`).join(' or ')}`);
  }
  return chosen as T;
}

/** The plain settings of a policy, each checked and defaulted. */
export function readSettings(options: PolicyOptions) {
  const version: unknown = options.version;
  if (version !== undefined && (typeof version !== 'string' || version.trim() === '')) {
    invalid('version must be a non empty string');
  }

  const labels: unknown = options.labels;
  if (labels !== undefined && typeof labels !== 'function') invalid('labels must be a function');

  return {
    version: version as string | undefined,
    labels: labels as PolicyOptions['labels'],
    default: choice('default', options.default, ['allow', 'deny']),
    onError: choice('onError', options.onError, ['closed', 'open']),
    mode: choice('mode', options.mode, ['enforce', 'audit']),
  };
}
