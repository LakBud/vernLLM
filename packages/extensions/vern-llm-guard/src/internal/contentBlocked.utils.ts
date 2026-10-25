import { LLMError } from 'vern-llm';

/**
 * The refusal. It names check ids and labels, never content, so the message is safe to log.
 * `failed` marks a refusal because a check could not answer, not because it found something.
 */
export function contentBlocked(
  version: string,
  phase: 'input' | 'output',
  check: string | undefined,
  labels: readonly string[],
  failed: boolean,
): LLMError {
  const reason =
    check === undefined
      ? `the checks could not be run (${phase})`
      : failed
        ? `check "${check}" could not be evaluated (${phase})`
        : `check "${check}" (${phase})`;

  return new LLMError(`Call blocked by guard: ${reason}`, 'invalid_params', {
    code: 'content_blocked',
    issues: {
      version,
      phase,
      checks: check === undefined ? [] : [check],
      labels: [...labels],
      ...(failed && { failed: true }),
    },
  });
}
