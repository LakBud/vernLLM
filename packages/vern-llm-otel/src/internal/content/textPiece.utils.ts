import { truncate } from './truncate.utils.js';

import type { ResolvedCapture } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

/**
 * One allowance per captured attribute, shared by every piece of text going into it, so the
 * attribute as a whole stays under `maxLength` however many messages it holds.
 */
function createBudget(maxLength: number) {
  let remaining = maxLength;

  return {
    /** `undefined` once the allowance is spent, so older pieces are left out, not marked. */
    take(text: string): string | undefined {
      if (text.length <= remaining) {
        remaining -= text.length;
        return text;
      }

      const cut = truncate(text, remaining);
      remaining = 0;
      return cut;
    },
    exhausted(): boolean {
      return remaining <= 0;
    },
  };
}

export interface TextPiece {
  (text: string): string | undefined;
  /** True once nothing more fits, so a caller can stop walking older content. */
  exhausted(): boolean;
}

/**
 * Redacts and then budgets one piece of text. `undefined` means the piece must be left out:
 * a redactor that throws or returns something other than a string never lets the original
 * text through.
 */
export function createTextPiece(
  capture: ResolvedCapture,
  guard: Guard,
  maxLength: number = capture.maxLength,
  redacted: Map<string, unknown> = new Map(),
): TextPiece {
  const budget = createBudget(maxLength);
  const { redact } = capture;

  const piece = (text: string): string | undefined => {
    let value = text;

    if (redact) {
      // Shared across rebuilds of one attribute, so the redactor runs once per piece of text.
      let result = redacted.get(text);
      if (!redacted.has(text)) {
        result = guard<unknown>('captureContent.redact', () => redact(text), undefined);
        redacted.set(text, result);
      }
      if (typeof result !== 'string') return undefined;
      value = result;
    }

    return budget.take(value);
  };
  return Object.assign(piece, { exhausted: () => budget.exhausted() });
}
