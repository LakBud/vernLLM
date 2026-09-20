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
    take(text: string): string {
      if (text.length <= remaining) {
        remaining -= text.length;
        return text;
      }

      const cut = truncate(text, remaining);
      remaining = 0;
      return cut;
    },
  };
}

/**
 * Redacts and then budgets one piece of text. `undefined` means the piece must be left out:
 * a redactor that throws or returns something other than a string never lets the original
 * text through.
 */
export function createTextPiece(
  capture: ResolvedCapture,
  guard: Guard,
): (text: string) => string | undefined {
  const budget = createBudget(capture.maxLength);
  const { redact } = capture;

  return (text) => {
    let value = text;

    if (redact) {
      const redacted = guard<unknown>('captureContent.redact', () => redact(text), undefined);
      if (typeof redacted !== 'string') return undefined;
      value = redacted;
    }

    return budget.take(value);
  };
}
