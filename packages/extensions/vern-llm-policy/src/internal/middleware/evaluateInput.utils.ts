import { readOnly } from '../facts/readOnly.utils.js';
import { invalid } from '../options/invalid.utils.js';

import type { CallFacts, EvaluateInput } from '../../types/index.js';
import type { CompiledPolicy, EvaluatedTarget } from '../../types/resolvedConfig.js';
import type { TargetInfo } from 'vern-llm';

const REQUEST_BOOLEANS = ['hasTools', 'jsonOutput', 'images', 'streaming'] as const;

/** A target as the core describes it. */
function toTargetInfo(
  target: EvaluateInput['targets'][number],
  index: number,
  path: string,
): TargetInfo {
  const raw: unknown = target;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof target.name !== 'string' ||
    typeof target.model !== 'string'
  ) {
    invalid(`${path} must be an object with a name and a model`);
  }
  if (target.provider !== undefined && typeof target.provider !== 'string') {
    invalid(`${path}.provider must be a string when it is given`);
  }
  return {
    name: target.name,
    index,
    model: target.model,
    adapter: {
      name: 'custom',
      ...(target.provider !== undefined && { provider: target.provider }),
    },
  };
}

/** The request facts of an `evaluate` input, defaulted, so a typo is not a silent `false`. */
function requestFacts(request: EvaluateInput['request']): CallFacts['request'] {
  const raw: unknown = request ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('evaluate request must be an object');
  }

  const given = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(given)) {
    if (key === 'inputTokens') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        invalid('evaluate request.inputTokens must be a number of at least 0');
      }
    } else if (!(REQUEST_BOOLEANS as readonly string[]).includes(key)) {
      invalid(`evaluate request has an unknown fact "${key}"`);
    } else if (typeof value !== 'boolean') {
      invalid(`evaluate request.${key} must be true or false`);
    }
  }

  return Object.freeze({
    hasTools: false,
    jsonOutput: false,
    images: false,
    inputTokens: 0,
    streaming: false,
    ...(given as Partial<CallFacts['request']>),
  });
}

/** The labels of an `evaluate` input, copied and without repeats. */
function inputLabels(labels: readonly string[]): readonly string[] {
  const raw: unknown = labels;
  if (!Array.isArray(raw) || !raw.every((label) => typeof label === 'string')) {
    invalid('evaluate labels must be a list of strings');
  }
  return Object.freeze([...new Set(labels)]);
}

/** What `evaluate` needs, from an `EvaluateInput`. A mistake in the input throws. */
export function readEvaluateInput(
  policy: CompiledPolicy,
  input: EvaluateInput,
  targetFacts: (info: TargetInfo) => EvaluatedTarget['facts'],
): { call: CallFacts; targets: EvaluatedTarget[]; now: number } {
  const raw: unknown = input;
  if (typeof raw !== 'object' || raw === null || !Array.isArray(input.targets)) {
    invalid('evaluate input must be an object with a list of targets');
  }

  const infos = input.targets.map((target, index) =>
    toTargetInfo(target, index, `evaluate targets[${index}]`),
  );
  const now = input.now === undefined ? Date.now() : Number(input.now);
  if (Number.isNaN(now)) invalid('evaluate now must be a Date or a number');

  const call: CallFacts = Object.freeze({
    ...(input.context !== undefined && {
      context: policy.needs.functions ? readOnly(input.context) : input.context,
    }),
    ...(input.labels !== undefined && { labels: inputLabels(input.labels) }),
    request: requestFacts(input.request),
    callTargets: input.callTargets === true,
  });

  return {
    call,
    targets: infos.map((info) => ({ name: info.name, facts: targetFacts(info) })),
    now,
  };
}
