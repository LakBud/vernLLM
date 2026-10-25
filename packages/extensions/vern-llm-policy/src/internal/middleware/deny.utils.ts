import { LLMError } from 'vern-llm';

import type { Decision } from '../../types/decision.js';

/** The error for a refused call. Only rule ids and target names go in, never `context` values. */
export function policyDenied(decision: Decision): LLMError {
  const byDefault = Object.values(decision.removed).includes('default');
  const rules = decision.rules.join(', ');

  const reason =
    decision.rules.length === 0
      ? 'the default is deny and no rule allows any target'
      : byDefault
        ? `${rules} and the default deny removed every target`
        : `${rules} removed every target`;

  return new LLMError(`Call denied by policy: ${reason}`, 'invalid_params', {
    code: 'policy_denied',
    issues: {
      ...(decision.version !== undefined && { version: decision.version }),
      rules: decision.rules,
      removed: decision.removed,
    },
  });
}

/** Policy could not decide, so the call is refused rather than run unchecked. */
export function policyFailed(version: string | undefined): LLMError {
  return new LLMError(
    'Call denied by policy: the policy could not be evaluated',
    'invalid_params',
    {
      code: 'policy_denied',
      ...(version !== undefined && { issues: { version } }),
    },
  );
}
