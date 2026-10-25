import type { DecisionException } from '../../types/decision.js';

export const NO_REMOVALS: Readonly<Record<string, string>> = Object.freeze({});
export const NO_AUDIT: Readonly<Record<string, readonly string[]>> = Object.freeze({});
export const NO_FLAGS: Readonly<Record<string, boolean>> = Object.freeze({});
export const NO_EXCEPTIONS: readonly DecisionException[] = Object.freeze([]);
