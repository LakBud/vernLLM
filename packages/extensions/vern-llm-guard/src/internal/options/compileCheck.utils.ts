import { invalid } from './invalid.utils.js';
import {
  ACTIONS,
  DEFAULT_TIMEOUT_MS,
  ERROR_MODES,
  MODES,
  ON_VALUES,
  ROLES,
  isRecord,
  oneOf,
} from './settings.utils.js';
import { choice, nonEmptyString, optionalBoolean, optionalFunction } from './validate.utils.js';

import type { Check, CheckOn, Source } from '../../types/index.js';
import type { CompiledCheck } from '../../types/resolvedConfig.js';

/** What `on` names, as a list: absent means the request. */
function onList(on: unknown): unknown[] {
  if (on === undefined) return ['input'];
  return Array.isArray(on) ? (on as unknown[]) : [on];
}

function compileOn(field: string, on: unknown): ReadonlySet<Source> {
  const list = onList(on);
  if (list.length === 0) invalid(`${field} must not be empty`);

  const sources = new Set<Source>();
  for (const entry of list) {
    if (typeof entry !== 'string' || !ON_VALUES.includes(entry)) {
      invalid(`${field} must be ${oneOf(ON_VALUES)}, or a list of them`);
    }
    if ((entry as CheckOn) === 'input') for (const role of ROLES) sources.add(role);
    else sources.add(entry as Source);
  }
  return sources;
}

/** The longest delay `setTimeout` takes: a larger one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function timeoutOf(value: unknown, at: string): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    invalid(`${at}.timeoutMs must be a positive number, at most ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

export function compileCheck(raw: unknown, index: number, instanceClosed: boolean): CompiledCheck {
  const at = `checks[${index}]`;
  if (!isRecord(raw)) invalid(`${at} must be an object`);

  const check = raw as unknown as Partial<Check> & Record<string, unknown>;
  const id = nonEmptyString(check.id, `${at}.id`);
  if (typeof check.detect !== 'function') invalid(`${at}.detect must be a function`);

  const action = choice<CompiledCheck['action']>(check.action, 'label', ACTIONS, `${at}.action`);
  const mode = choice<'enforce' | 'audit'>(check.mode, 'enforce', MODES, `${at}.mode`);
  const onError = choice<'closed' | 'open'>(
    check.onError,
    instanceClosed ? 'closed' : 'open',
    ERROR_MODES,
    `${at}.onError`,
  );
  if (check.label !== undefined) nonEmptyString(check.label, `${at}.label`);
  optionalFunction(check.when, `${at}.when`);
  optionalFunction(check.redactFor, `${at}.redactFor`);
  optionalBoolean(check.restore, `${at}.restore`);
  if (action !== 'redact' && (check.redactFor !== undefined || check.restore !== undefined)) {
    invalid(`${at}.redactFor and ${at}.restore are only for action 'redact'`);
  }
  optionalBoolean(check.parallel, `${at}.parallel`);
  const sources = compileOn(`${at}.on`, check.on);
  if (check.parallel === true && (action !== 'block' || sources.has('output'))) {
    invalid(`${at}.parallel is only for input checks with action 'block'`);
  }
  const timeoutMs = timeoutOf(check.timeoutMs, at);

  return Object.freeze({
    id,
    detect: check.detect,
    sources,
    action,
    label: check.label ?? id,
    when: check.when,
    redactFor: check.redactFor,
    restore: check.restore ?? true,
    parallel: check.parallel === true,
    audit: mode === 'audit',
    timeoutMs,
    failClosed: onError === 'closed',
  });
}
