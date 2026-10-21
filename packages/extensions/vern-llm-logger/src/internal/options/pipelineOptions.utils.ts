import { fail, optionalBoolean, optionalObject } from './validate.utils.js';

import type { LoggerMiddlewareOptions } from '../../types/index.js';

export const DEFAULT_NAME = 'logger';

/** The share of plain successes kept, from 0 to 1. Everything else is always kept. */
export function normalizeSampleSuccess(value: LoggerMiddlewareOptions['sample']): number {
  optionalObject(value, 'sample');
  const success = value?.success === undefined ? 1 : value.success;
  if (typeof success !== 'number' || !(success >= 0 && success <= 1)) {
    fail('sample.success must be a number from 0 to 1');
  }
  return success;
}

export function normalizeErrorGrouping(value: boolean | undefined): boolean {
  optionalBoolean(value, 'errorGrouping');
  return value ?? true;
}

export function normalizeName(value: string | undefined): string {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    fail('name must be a non-empty string');
  }
  return value ?? DEFAULT_NAME;
}

export function normalizeLogger(
  value: LoggerMiddlewareOptions['logger'],
): LoggerMiddlewareOptions['logger'] {
  if (value !== undefined && value !== 'silent' && (typeof value !== 'object' || value === null)) {
    fail("logger must be a Logger or 'silent'");
  }
  return value;
}
