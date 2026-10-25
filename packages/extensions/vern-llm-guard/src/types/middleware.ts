import type { EvaluateInput, GuardUpdate } from './options.js';
import type { GuardResult } from './result.js';
import type { VernLLMMiddleware } from 'vern-llm';

/** The middleware, with the ways to use the same checks outside a call. */
export interface GuardMiddleware extends VernLLMMiddleware {
  /**
   * Runs the real checks on plain data and gives the result a call would have emitted, with no
   * call made. For a CI job over labeled prompts and answers, before a check leaves audit.
   */
  evaluate(input: EvaluateInput): Promise<GuardResult>;
  /**
   * Swaps in new checks. They are validated completely first: a bad update throws and the old
   * checks stay. A call in flight finishes on the checks it started with.
   */
  update(update: GuardUpdate): void;
  /**
   * Masks what the `redact` and `block` checks find in a text, for the core's `redact` option.
   * Synchronous, so a check that answers with a promise is skipped. Never throws.
   */
  redactText(text: string): string;
}
