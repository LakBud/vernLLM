import { isPlainObject, isScalar, RESERVED_KEYS } from '../match/value.utils.js';
import { invalid } from './invalid.utils.js';

import type { PolicyOptions, Scalar } from '../../types/options.js';

/** Attributes every target has. */
export const BUILT_IN_ATTRIBUTES: readonly string[] = ['name', 'model', 'provider'];

type Attributes = Readonly<Record<string, Scalar>>;

function compileAttributes(name: string, attributes: unknown): Attributes {
  if (!isPlainObject(attributes)) invalid(`targets["${name}"] must be an object of attributes`);

  const entries = Object.entries(attributes).map(([attribute, value]) => {
    const at = `targets["${name}"].${attribute}`;
    const reserved =
      RESERVED_KEYS.has(attribute) ||
      attribute === '__proto__' ||
      BUILT_IN_ATTRIBUTES.includes(attribute);
    if (reserved) invalid(`${at} is a reserved name, so a target cannot declare it`);
    if (!isScalar(value)) invalid(`${at} must be a string, number or boolean`);
    return [attribute, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

/** The declared attributes per target, copied and frozen. */
export function compileTargets(
  targets: PolicyOptions['targets'],
): Readonly<Record<string, Attributes>> {
  if (targets === undefined) return Object.freeze({});
  if (!isPlainObject(targets)) invalid('targets must be an object of target names to attributes');

  // `fromEntries` keeps a `__proto__` target plain data.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(targets).map(([name, attributes]) => [
        name,
        compileAttributes(name, attributes),
      ]),
    ),
  );
}
