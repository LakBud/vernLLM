import { describe, errorName } from '../errors.utils.js';

import type { CompiledPolicy } from '../../types/resolvedConfig.js';
import type { PreDispatchContext } from 'vern-llm';

/** What the `labels` option said for this call. */
export interface LabelsRead {
  /** Absent when unknown. */
  labels?: readonly string[];
  /** Set when the function threw or answered with the wrong shape. */
  error?: { name: string; message: string };
}

/** Runs `labels`, once per call. `undefined`, a throw or a bad answer all mean unknown, not `[]`. */
export function readLabels(policy: CompiledPolicy, ctx: PreDispatchContext): LabelsRead {
  if (!policy.needs.labels || policy.labels === undefined) return {};

  try {
    const result: unknown = policy.labels(ctx);
    if (result === undefined) return {};
    if (!Array.isArray(result) || !result.every((label) => typeof label === 'string')) {
      return {
        error: {
          name: 'TypeError',
          message: 'the labels function must return a list of strings, or undefined',
        },
      };
    }
    return { labels: Object.freeze([...result] as string[]) };
  } catch (error) {
    return { error: { name: errorName(error), message: describe(error) } };
  }
}
