import {
  DEFAULT_CAUSE,
  type CompiledException,
  type CompiledRule,
  type PolicyNeeds,
} from '../../types/resolvedConfig.js';
import { isPlainObject } from '../match/value.utils.js';
import { compileExceptions } from './compileExceptions.utils.js';
import { invalid } from './invalid.utils.js';
import { buildMatcher, checkAttributes, checkCallPattern } from './validate.utils.js';

import type { Matcher, MatcherOptions } from '../match/types.js';

const RULE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'when',
  'allow',
  'forbid',
  'set',
  'except',
  'mode',
]);
const TARGET_PATTERN: MatcherOptions = { nested: false };
const CALL_PATTERN: MatcherOptions = { nested: true };

export function compileRule(
  rule: unknown,
  index: number,
  ids: Set<string>,
  known: ReadonlySet<string>,
  needs: PolicyNeeds,
  policyMode: 'enforce' | 'audit',
  hasLabels: boolean,
): CompiledRule {
  const at = `rules[${index}]`;
  if (!isPlainObject(rule)) invalid(`${at} must be an object`);

  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) invalid(`${at} has an unknown field "${key}"`);
  }

  const id = rule.id;
  if (typeof id !== 'string' || id.trim() === '') invalid(`${at}.id must be a non empty string`);
  if (id === DEFAULT_CAUSE)
    invalid(`${at}.id "${id}" is reserved for the default, so pick another`);
  if (ids.has(id)) invalid(`${at}.id "${id}" is used by another rule, and ids must be unique`);
  ids.add(id);

  const label = `rule "${id}"`;
  const hasAllow = rule.allow !== undefined;
  const hasForbid = rule.forbid !== undefined;
  if (hasAllow && hasForbid) invalid(`${label} must have only one of allow and forbid`);
  const hasSet = rule.set !== undefined;
  if (!hasAllow && !hasForbid && !hasSet) invalid(`${label} must have allow, forbid or set`);

  const ruleMode = rule.mode ?? policyMode;
  if (ruleMode !== 'enforce' && ruleMode !== 'audit') {
    invalid(`${at}.mode must be 'enforce' or 'audit'`);
  }

  const compiled: {
    id: string;
    mode: 'enforce' | 'audit';
    when?: Matcher;
    allow?: Matcher;
    forbid?: Matcher;
    set?: Readonly<Record<string, boolean>>;
    except: readonly CompiledException[];
  } = { id, mode: ruleMode, except: [] };

  if (rule.when !== undefined) {
    compiled.when = buildMatcher(rule.when, `${label} when`, CALL_PATTERN);
    checkCallPattern(rule.when, `${label} when`, needs, hasLabels);
  }

  if (hasSet) compiled.set = compileFlags(rule.set, label);
  if (rule.except !== undefined) {
    compiled.except = compileExceptions(rule.except, label, needs, hasLabels);
  }

  if (hasAllow) {
    compiled.allow = buildMatcher(rule.allow, `${label} allow`, TARGET_PATTERN);
    checkAttributes(rule.allow, `${label} allow`, known);
  }

  if (hasForbid) {
    if (rule.forbid === 'all') {
      compiled.forbid = () => true;
    } else {
      compiled.forbid = buildMatcher(rule.forbid, `${label} forbid`, TARGET_PATTERN);
      checkAttributes(rule.forbid, `${label} forbid`, known);
    }
  }

  return Object.freeze(compiled);
}

function compileFlags(set: unknown, label: string): Readonly<Record<string, boolean>> {
  if (!isPlainObject(set) || Object.keys(set).length === 0) {
    invalid(`${label} set must be an object of at least one flag`);
  }

  const flags: [string, boolean][] = [];
  for (const [name, value] of Object.entries(set)) {
    if (name.trim() === '' || name === '__proto__')
      invalid(`${label} set has an invalid flag name`);
    if (typeof value !== 'boolean') invalid(`${label} set.${name} must be true or false`);
    flags.push([name, value]);
  }
  // `fromEntries` keeps a `__proto__` flag name plain data.
  return Object.freeze(Object.fromEntries(flags));
}
