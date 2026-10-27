import {
  MODERATION_CATEGORIES,
  MODERATION_PREFIX,
  type ModerationCategory,
  type ModerationResult,
} from '../../detectors/openaiModeration.types.js';

import type { Hit } from '../hosted/types.js';

export type ModerationThresholds = { [K in ModerationCategory]?: number };

/** Whether a result counts a category: by its threshold when it has one, otherwise by the flag. */
function counts(
  result: ModerationResult,
  category: string,
  thresholds: ModerationThresholds,
): boolean {
  const limit = thresholds[category as ModerationCategory];
  if (limit === undefined) return result.categories[category as ModerationCategory] === true;
  return (result.category_scores?.[category as ModerationCategory] ?? -1) >= limit;
}

/**
 * The findings of one result: every category it counts, including one the API reports that this
 * version does not know, labelled over the whole segment.
 */
export function hitsOf(result: ModerationResult, thresholds: ModerationThresholds): Hit[] {
  const names = new Set([...MODERATION_CATEGORIES, ...Object.keys(result.categories)]);
  return [...names]
    .filter((name) => counts(result, name, thresholds))
    .map((name) => ({ label: `${MODERATION_PREFIX}${name}` }));
}
