import { fail, isPlainObject, optionalBoolean, stringList } from './validate.utils.js';

import type { CustomEventsOptions } from '../../types/index.js';

/** First party extensions show up with no configuration. */
export const DEFAULT_CUSTOM_EVENTS: readonly string[] = [
  'usage.*',
  'policy.*',
  'router.*',
  'guard.*',
  'hedge.*',
];

// A plain name (`myapp.cache_warm`) or a prefix pattern (`myapp.*`). Nothing fancier, so a
// pattern can never become an expensive regular expression.
const PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(\.\*)?$/;

/** Compiles the patterns once into a predicate. */
export function normalizeCustomEvents(
  option: string[] | CustomEventsOptions | undefined,
): (name: string) => boolean {
  let names: string[] = [];
  let defaults = true;

  if (Array.isArray(option)) {
    names = stringList(option, 'customEvents');
  } else if (option !== undefined) {
    if (!isPlainObject(option)) fail('customEvents must be an array or an object');
    optionalBoolean(option.defaults, 'customEvents.defaults');
    defaults = option.defaults ?? true;
    if (option.names !== undefined) names = stringList(option.names, 'customEvents.names');
  }

  for (const pattern of names) {
    if (!PATTERN.test(pattern)) {
      fail(`customEvents pattern "${pattern}" must be a plain name or "prefix.*"`);
    }
  }

  const patterns = defaults ? [...DEFAULT_CUSTOM_EVENTS, ...names] : names;
  const exact = new Set<string>();
  const prefixes: string[] = [];

  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) prefixes.push(pattern.slice(0, -1));
    else exact.add(pattern);
  }

  return (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}
