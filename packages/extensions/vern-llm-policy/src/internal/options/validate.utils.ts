import { PatternError } from '../match/errors.js';
import { compileMatcher } from '../match/match.utils.js';
import { patternKeys } from '../match/patternKeys.utils.js';
import { isPlainObject } from '../match/value.utils.js';
import { invalid } from './invalid.utils.js';

import type { PolicyNeeds } from '../../types/resolvedConfig.js';
import type { Matcher, MatcherOptions } from '../match/types.js';

const CALL_FACTS: ReadonlySet<string> = new Set(['context', 'request', 'callTargets', 'labels']);
const REQUEST_FACTS: ReadonlySet<string> = new Set([
  'hasTools',
  'jsonOutput',
  'images',
  'inputTokens',
  'streaming',
]);

export function buildMatcher(pattern: unknown, path: string, options: MatcherOptions): Matcher {
  try {
    return compileMatcher(pattern, path, options);
  } catch (error) {
    if (error instanceof PatternError) invalid(error.message);
    throw error;
  }
}

/** A typo like `regoin` is an error here, not a rule that never matches. */
export function checkAttributes(pattern: unknown, path: string, known: ReadonlySet<string>): void {
  for (const key of patternKeys(pattern)) {
    if (!known.has(key)) {
      invalid(
        `${path} uses the unknown attribute "${key}". Known attributes: ${[...known].sort().join(', ')}`,
      );
    }
  }
}

interface CallCheck {
  path: string;
  needs: PolicyNeeds;
  hasLabels: boolean;
}

/** Costly facts a function may read, so it needs all of them. */
const FUNCTION_NEEDS: Partial<PolicyNeeds> = {
  inputTokens: true,
  images: true,
  functions: true,
  // A function may read labels, so the labeler runs for it, but unknown labels are no mistake.
  labels: true,
};

const REQUEST_NEEDS = new Map<string, keyof PolicyNeeds>([
  ['inputTokens', 'inputTokens'],
  ['images', 'images'],
]);

const CALL_CHECKS = new Map<string, (value: unknown, check: CallCheck) => void>([
  ['not', (value, check) => checkCallPattern(value, check.path, check.needs, check.hasLabels)],
  [
    'any',
    (value, check) =>
      (value as unknown[]).forEach((member) =>
        checkCallPattern(member, check.path, check.needs, check.hasLabels),
      ),
  ],
  [
    'context',
    (value, { path }) => {
      if (!isPlainObject(value))
        invalid(`${path}.context must be a pattern over the call's context`);
    },
  ],
  [
    'request',
    (value, { path, needs }) => {
      if (!isPlainObject(value))
        invalid(`${path}.request must be a pattern over the request facts`);
      patternKeys(value).forEach((fact) => {
        if (!REQUEST_FACTS.has(fact)) {
          invalid(
            `${path}.request uses the unknown fact "${fact}". Request facts: ${[...REQUEST_FACTS].join(', ')}`,
          );
        }
        const need = REQUEST_NEEDS.get(fact);
        if (need !== undefined) needs[need] = true;
      });
    },
  ],
  [
    'labels',
    (_value, { path, needs, hasLabels }) => {
      if (!hasLabels) invalid(`${path} matches on labels, so the labels option is required`);
      Object.assign(needs, { labels: true, readsLabels: true });
    },
  ],
  [
    'callTargets',
    (value, { path }) => {
      if (typeof value !== 'boolean') invalid(`${path}.callTargets must be true or false`);
    },
  ],
]);

/** Checks a `when` pattern reads only call facts, and records which costly ones it needs. */
export function checkCallPattern(
  pattern: unknown,
  path: string,
  needs: PolicyNeeds,
  hasLabels: boolean,
): void {
  if (typeof pattern === 'function') {
    Object.assign(needs, FUNCTION_NEEDS);
    return;
  }

  Object.entries(pattern as Record<string, unknown>).forEach(([key, value]) => {
    const check = CALL_CHECKS.get(key);
    if (check === undefined) {
      invalid(
        `${path} uses "${key}", which is not a call fact. Call facts: ${[...CALL_FACTS].join(', ')}`,
      );
    }
    check(value, { path, needs, hasLabels });
  });
}
