import { applyReplacements } from '../segments/applyReplacements.utils.js';
import { outputSegments } from '../segments/outputSegments.utils.js';
import { unmark } from '../spotlight/spotlight.js';
import { restoreTokens, type TokenMap } from '../tokens/tokens.js';

import type { Replacement } from '../segments/types.js';

/**
 * Only the last step: tokens become values and a spotlight marker becomes a space. For when the
 * checks cannot run and the guard lets the answer through, which must still not show a token.
 */
export function restoreOnly(value: unknown, tokens: TokenMap, marker: string | undefined): unknown {
  const extracted = outputSegments(value);
  const replacements: Replacement[] = [];

  extracted.segments.forEach((segment, index) => {
    if (extracted.fixed[index]) return;
    const text = restoreTokens(unmark(segment.text, marker), tokens).text;
    if (text !== segment.text) {
      replacements.push({ segment: index, start: 0, end: segment.text.length, text });
    }
  });
  return replacements.length === 0 ? value : applyReplacements(value, extracted, replacements);
}
