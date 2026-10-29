import { createStateKey, LLMError, stateEntry, type MiddlewareStateBag } from 'vern-llm';

import type { Guard } from '../guard.utils.js';

/** Marks a call made by `llmClassifier`. */
export const classifierCallKey = createStateKey<boolean>('guard.classifierCall');

export const classifierCallState = [stateEntry(classifierCallKey, true)] as const;

const MESSAGE =
  'Call refused: llmClassifier was given a VernLLM that has a guard on it, so the guard would scan every classification and call the classifier again. Give llmClassifier its own VernLLM';

/** Throws for a classifier's call, so a guard never scans its own classifier. */
export function refuseClassifierCall(state: MiddlewareStateBag, guard: Guard): void {
  if (state.get(classifierCallKey) !== true) return;

  guard.warnOnce('classifier-call', MESSAGE);
  throw new LLMError(MESSAGE, 'invalid_params');
}
