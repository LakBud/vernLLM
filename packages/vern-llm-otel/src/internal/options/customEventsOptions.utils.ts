import { optionalBoolean, resolveMaxLength } from './validate.utils.js';

import type { CustomEventsOptions } from '../../types/index.js';

export const DEFAULT_CUSTOM_DATA_MAX_LENGTH = 8192;

export function normalizeCustomEvents(
  option: boolean | CustomEventsOptions | undefined,
): { data: boolean; maxLength: number } | undefined {
  if (option === false) return undefined;

  if (option !== undefined && option !== true) {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) {
      throw new Error('otelMiddleware: customEvents must be a boolean or an object');
    }
    optionalBoolean(option.data, 'customEvents.data');
  }

  const o: CustomEventsOptions = typeof option === 'object' ? option : {};

  return {
    data: o.data ?? false,
    maxLength: resolveMaxLength(
      o.maxLength,
      'customEvents.maxLength',
      DEFAULT_CUSTOM_DATA_MAX_LENGTH,
    ),
  };
}
