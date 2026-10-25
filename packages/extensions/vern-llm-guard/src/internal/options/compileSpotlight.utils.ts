import { invalid } from './invalid.utils.js';
import { SPOTLIGHT_SOURCES, isRecord, oneOf } from './settings.utils.js';

import type { GuardOptions, Source } from '../../types/index.js';

/** The sources spotlight marks, or `undefined` when it is off. */
export function compileSpotlight(options: GuardOptions): ReadonlySet<Source> | undefined {
  if (options.spotlight === undefined) return undefined;
  if (!isRecord(options.spotlight)) invalid('spotlight must be an object');
  const list = options.spotlight.sources ?? ['tool'];
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((entry) => typeof entry === 'string' && SPOTLIGHT_SOURCES.includes(entry))
  ) {
    invalid(`spotlight.sources must be a list of ${oneOf(SPOTLIGHT_SOURCES)}`);
  }
  return new Set(list as Source[]);
}
