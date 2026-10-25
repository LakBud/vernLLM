import { isPlainObject } from '../match/value.utils.js';
import { invalid } from './invalid.utils.js';
import { isRealUntil } from './until.utils.js';
import { buildMatcher, checkCallPattern } from './validate.utils.js';

import type { CompiledException, PolicyNeeds } from '../../types/resolvedConfig.js';
import type { MatcherOptions } from '../match/types.js';

const EXCEPTION_KEYS: ReadonlySet<string> = new Set(['when', 'until', 'reason']);
const CALL_PATTERN: MatcherOptions = { nested: true };

export function compileExceptions(
  except: unknown,
  label: string,
  needs: PolicyNeeds,
  hasLabels: boolean,
): readonly CompiledException[] {
  if (!Array.isArray(except) || except.length === 0) {
    invalid(`${label} except must be a non empty list of exceptions`);
  }

  return Object.freeze(
    except.map((exception: unknown, index) => {
      const at = `${label} except[${index}]`;
      if (!isPlainObject(exception)) invalid(`${at} must be an object`);

      for (const key of Object.keys(exception)) {
        if (!EXCEPTION_KEYS.has(key)) invalid(`${at} has an unknown field "${key}"`);
      }

      const { when, until, reason } = exception;
      if (when === undefined) {
        invalid(`${at}.when is required, since an exception with none would cover every call`);
      }
      if (typeof until !== 'string' || !isRealUntil(until)) {
        invalid(
          `${at}.until is required and must be an ISO date such as "2026-11-01", or a date and time with an offset`,
        );
      }
      if (typeof reason !== 'string' || reason.trim() === '') {
        invalid(`${at}.reason must be a non empty string`);
      }

      const matcher = buildMatcher(when, `${at}.when`, CALL_PATTERN);
      checkCallPattern(when, `${at}.when`, needs, hasLabels);
      return Object.freeze({ when: matcher, until, end: Date.parse(until), reason });
    }),
  );
}
