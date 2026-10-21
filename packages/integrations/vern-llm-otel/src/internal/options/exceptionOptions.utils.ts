import { optionalBoolean } from './validate.utils.js';

import type { RecordExceptionsOptions } from '../../types/index.js';

export function normalizeExceptions(
  option: boolean | RecordExceptionsOptions | undefined,
): { stack: boolean } | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { stack: false };

  if (typeof option !== 'object' || option === null || Array.isArray(option)) {
    throw new Error('otelMiddleware: recordExceptions must be a boolean or an object');
  }
  optionalBoolean(option.stack, 'recordExceptions.stack');

  return { stack: option.stack ?? false };
}
