import { LLMError } from '../../../types/errors.js';
import {
  RetryBudget,
  type RetryBudgetAdapter,
  type RetryBudgetOptions,
} from '../../retryBudget.js';

import type { Logger } from '../../../logger.js';

/** What `retryBudget` accepts: options for the built in budget, or an adapter. */
export type RetryBudgetOption = RetryBudgetOptions | RetryBudgetAdapter;

const ADAPTER_METHOD_NAMES = ['assertAvailable', 'recordAttempt'] as const;

/** Optional `RetryBudgetAdapter` members that must be functions when present. */
const OPTIONAL_FUNCTION_MEMBER_NAMES = ['getSnapshot', 'readState', 'setLogger'] as const;

/**
 * Resolves `retryBudget` into an adapter, or `undefined` for no budget. Any adapter method makes
 * the object an adapter, so a half built one throws now instead of being read as options.
 */
export function buildRetryBudget(
  option: RetryBudgetOption | undefined,
  logger?: Logger,
): RetryBudgetAdapter | undefined {
  // Falsy disables it, as before adapters existed, so `retryBudget: enabled && {...}` still works.
  if (!option) return undefined;

  const members = option as unknown as Record<string, unknown>;
  const isFunction = (name: string) => typeof members[name] === 'function';
  if (!ADAPTER_METHOD_NAMES.some(isFunction)) return new RetryBudget(option as RetryBudgetOptions);

  const missing = ADAPTER_METHOD_NAMES.filter((name) => !isFunction(name));
  if (missing.length > 0) {
    throw new LLMError(
      `retryBudget looks like a RetryBudgetAdapter but is missing: ${missing.join(', ')}. Both ${ADAPTER_METHOD_NAMES.join(' and ')} are required.`,
      'invalid_params',
    );
  }

  const invalid = OPTIONAL_FUNCTION_MEMBER_NAMES.filter(
    (name) => members[name] !== undefined && !isFunction(name),
  );
  if (invalid.length > 0) {
    const described = invalid.map((name) => `${name} (${typeof members[name]})`).join(', ');
    throw new LLMError(
      `retryBudget's ${described} must be a function. ${invalid.length === 1 ? 'It is' : 'They are'} optional; omit entirely rather than assigning a non-function value.`,
      'invalid_params',
    );
  }

  const adapter = option as RetryBudgetAdapter;
  if (logger) adapter.setLogger?.(logger);
  return adapter;
}
