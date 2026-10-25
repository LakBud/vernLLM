import { isPlainObject } from '../match/value.utils.js';
import { compileRule } from './compileRule.utils.js';
import { BUILT_IN_ATTRIBUTES, compileTargets } from './compileTargets.utils.js';
import { invalid } from './invalid.utils.js';
import { readSettings } from './settings.utils.js';

import type { PolicyOptions } from '../../types/options.js';
import type { CompiledPolicy, PolicyNeeds } from '../../types/resolvedConfig.js';

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'version',
  'onError',
  'mode',
  'default',
  'targets',
  'rules',
  'labels',
  'logger',
]);

/** Validates `options` completely and compiles them. A mistake throws before any call runs. */
export function compile(options: PolicyOptions): CompiledPolicy {
  // Checked as `unknown`, so the guard does not narrow `options`.
  const raw: unknown = options;
  if (!isPlainObject(raw)) invalid('options must be an object');
  Object.keys(raw)
    .filter((key) => !OPTION_KEYS.has(key))
    .forEach((key) => invalid(`unknown option "${key}"`));

  const settings = readSettings(options);
  const declared = compileTargets(options.targets);
  const known = new Set([...BUILT_IN_ATTRIBUTES, ...Object.values(declared).flatMap(Object.keys)]);

  const rules: unknown = options.rules ?? [];
  if (!Array.isArray(rules)) invalid('rules must be an array');

  const needs: PolicyNeeds = {
    inputTokens: false,
    images: false,
    labels: false,
    readsLabels: false,
    functions: false,
  };
  const ids = new Set<string>();
  const hasLabels = settings.labels !== undefined;
  const compiled = rules.map((rule, index) =>
    compileRule(rule, index, ids, known, needs, settings.mode, hasLabels),
  );

  return Object.freeze({
    ...(settings.version !== undefined && { version: settings.version }),
    onError: settings.onError,
    auditDefault: settings.mode === 'audit',
    default: settings.default,
    declared,
    rules: Object.freeze(compiled),
    ...(hasLabels && { labels: settings.labels as CompiledPolicy['labels'] }),
    needs: Object.freeze(needs),
  });
}
