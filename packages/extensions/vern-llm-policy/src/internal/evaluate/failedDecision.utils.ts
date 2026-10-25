import { errorName, describe } from '../errors.utils.js';
import { NO_AUDIT, NO_EXCEPTIONS, NO_FLAGS, NO_REMOVALS } from './empty.js';

import type { Decision } from '../../types/decision.js';
import type { CompiledPolicy } from '../../types/resolvedConfig.js';

/** The decision when the policy itself failed: closed denies, open lets the call through. */
export function failedDecision(
  policy: CompiledPolicy,
  targetNames: readonly string[],
  error: unknown,
): Decision {
  const open = policy.onError === 'open';
  return {
    ...(policy.version !== undefined && { version: policy.version }),
    outcome: open ? 'allowed' : 'denied',
    allowed: open ? targetNames : [],
    removed: NO_REMOVALS,
    rules: [],
    audit: NO_AUDIT,
    errors: [{ name: errorName(error), message: describe(error) }],
    flags: NO_FLAGS,
    flagCauses: NO_REMOVALS,
    exceptions: NO_EXCEPTIONS,
  };
}
