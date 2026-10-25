import { PatternError } from './errors.js';
import { compileLabels } from './labels.utils.js';
import { isPlainObject, isScalar, read } from './value.utils.js';

import type { Matcher, MatcherOptions } from './types.js';

/** Stops a runaway pattern from recursing forever. */
const MAX_DEPTH = 8;

/**
 * Compiles a pattern once, so matching does no parsing. A missing fact never equals anything.
 *
 * @throws {PatternError} For an empty, too deep or unsupported pattern.
 */
export function compileMatcher(
  pattern: unknown,
  path: string,
  options: MatcherOptions,
  /** Whether `pattern` is matched against one fact's value, not a bag of facts. */
  onValue = false,
  depth = 0,
): Matcher {
  if (typeof pattern === 'function') {
    const test = pattern as (facts: unknown) => unknown;
    // Only an exact `true` matches.
    return (facts) => test(facts) === true;
  }

  if (!isPlainObject(pattern)) {
    throw new PatternError(`${path} must be a pattern: an object or a function`);
  }

  if (depth > MAX_DEPTH) {
    throw new PatternError(`${path} is nested more than ${MAX_DEPTH} levels deep`);
  }

  const keys = Object.keys(pattern);
  if (keys.length === 0) {
    // An empty pattern would match everything.
    throw new PatternError(`${path} must have at least one key`);
  }

  const checks = keys.map((key) =>
    compileKey(key, pattern[key], `${path}.${key}`, options, onValue, depth),
  );
  return checks.length === 1 ? checks[0]! : (facts) => checks.every((check) => check(facts));
}

type KeyCompiler = (
  value: unknown,
  path: string,
  options: MatcherOptions,
  onValue: boolean,
  depth: number,
) => Matcher;

/** Keys a pattern defines itself. Any other key names a fact. */
const OPERATORS = new Map<string, KeyCompiler>([
  [
    'not',
    (value, path, options, onValue, depth) => {
      const inner = compileMatcher(value, path, options, onValue, depth + 1);
      return (facts) => !inner(facts);
    },
  ],
  [
    'any',
    (value, path, options, onValue, depth) => {
      if (!Array.isArray(value) || value.length === 0) {
        throw new PatternError(`${path} must be a non empty list of patterns`);
      }
      const inner = value.map((member, index) =>
        compileMatcher(member, `${path}[${index}]`, options, onValue, depth + 1),
      );
      return (facts) => inner.some((check) => check(facts));
    },
  ],
  ['gte', compileBound((fact, bound) => fact >= bound)],
  ['lte', compileBound((fact, bound) => fact <= bound)],
]);

function compileBound(holds: (fact: number, bound: number) => boolean): KeyCompiler {
  return (value, path, _options, onValue) => {
    if (!onValue) {
      throw new PatternError(
        `${path} bounds a number, so it belongs inside a fact such as inputTokens`,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new PatternError(`${path} must be a finite number`);
    }
    return (facts) => typeof facts === 'number' && holds(facts, value);
  };
}

function compileKey(
  key: string,
  value: unknown,
  path: string,
  options: MatcherOptions,
  onValue: boolean,
  depth: number,
): Matcher {
  const operator = OPERATORS.get(key);
  if (operator !== undefined) return operator(value, path, options, onValue, depth);

  // At the top of a `when`, `labels` is a call fact. Inside `context` it is a key.
  if (key === 'labels' && options.nested && !onValue) return compileLabels(value, path);

  return compileFact(key, value, path, options, depth);
}

/** A fact equal to a value, one of several, or matching a nested pattern. */
function compileFact(
  key: string,
  value: unknown,
  path: string,
  options: MatcherOptions,
  depth: number,
): Matcher {
  if (isScalar(value)) return (facts) => read(facts, key) === value;

  if (Array.isArray(value)) {
    if (value.length === 0 || !value.every(isScalar)) {
      throw new PatternError(`${path} must be a non empty list of strings, numbers or booleans`);
    }
    const accepted = new Set<unknown>(value);
    return (facts) => accepted.has(read(facts, key));
  }

  if (options.nested && isPlainObject(value)) {
    const nested = compileMatcher(value, path, options, true, depth + 1);
    return (facts) => nested(read(facts, key));
  }

  throw new PatternError(
    options.nested
      ? `${path} must be a string, number, boolean, a list of them, or a nested pattern`
      : `${path} must be a string, number, boolean or a list of them`,
  );
}
