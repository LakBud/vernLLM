import type { Source } from '../../types/index.js';

export const DEFAULT_TIMEOUT_MS = 2000;
export const DEFAULT_MEMO_MAX = 10_000;

export const ROLES: readonly Source[] = ['user', 'tool', 'system', 'assistant'];
export const ON_VALUES: readonly string[] = ['input', ...ROLES, 'output'];
export const ACTIONS: readonly string[] = ['label', 'redact', 'block'];
export const MIN_KEY_BYTES = 32;
export const MIN_HOLD_CHARS = 32;
export const SPOTLIGHT_SOURCES: readonly string[] = ['tool', 'user', 'assistant'];
export const RELEASES: readonly string[] = ['checked', 'immediate'];
export const MODES: readonly string[] = ['enforce', 'audit'];
export const ERROR_MODES: readonly string[] = ['closed', 'open'];

export function oneOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
