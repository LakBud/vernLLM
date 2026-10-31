import { CLASSIFIER_PREFIX } from '../../detectors/llmClassifier.types.js';
import { matchSpans } from '../hosted/spans.js';

import type { Hit } from '../hosted/types.js';
import type { Verdict } from './request.js';

/**
 * The findings of one verdict. Without a located quote, a finding covers the whole text. With
 * levels a label ends in the category's level, so the result shows how strong it was.
 */
export function hitsOf(verdict: Verdict, text: string, quotes: boolean, levels = false): Hit[] {
  return [...new Set(verdict.categories)].flatMap((category) => {
    const level = levels ? `:${verdict.levels![category]!}` : '';
    const label = `${CLASSIFIER_PREFIX}${category}${level}`;
    const own = quotes && Object.hasOwn(verdict.quotes!, category);
    const found = own ? verdict.quotes![category] : undefined;
    return found !== undefined && found.length > 0 ? matchSpans(text, label, found) : [{ label }];
  });
}
