import { LLMError } from 'vern-llm';

/** Why the call was refused, in words that name a check and never what it found. */
function reasonFor(phase: 'input' | 'output', check: string | undefined, failed: boolean): string {
  if (check === undefined) return `the checks could not be run (${phase})`;
  if (failed) return `check "${check}" could not be evaluated (${phase})`;
  return `check "${check}" (${phase})`;
}

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
  return new LLMError(
    `Call blocked by guard: ${reasonFor(phase, check, failed)}`,
    'invalid_params',
    {
      code: 'content_blocked',
      issues: {
        version,
        phase,
        checks: check === undefined ? [] : [check],
        labels: [...labels],
        ...(failed && { failed: true }),
      },
    },
  );
}
