import { hitsOf } from '../internal/classifier/hits.js';
import { resolveClassifierOptions } from '../internal/classifier/options.utils.js';
import { createClassifierRequest } from '../internal/classifier/request.js';
import { createAnalyze } from '../internal/hosted/analyze.js';
import { createHosted } from '../internal/hosted/instance.js';
import {
  CLASSIFIER_NAME,
  CLASSIFIER_PREFIX,
  type LLMClassifierOptions,
} from './llmClassifier.types.js';

import type { Detector } from '../types/index.js';

export type {
  ClassifierAnswer,
  ClassifierLLM,
  ClassifierUsage,
  LLMClassifierOptions,
} from './llmClassifier.types.js';

/** What `only` takes after the categories, with `levels: true`. */
export interface ClassifierOnlyOptions {
  /** Findings below this level are left out. 1 to 3, default 1. */
  minLevel?: number;
}

/** A classifier detector, and `only` for a view of some categories, by level with `levels`. */
export type ClassifierDetector<Name extends string> = Detector & {
  /**
   * Another detector over the same calls and cache, returning only these categories. With
   * `levels: true` the last argument can be `{ minLevel }`.
   */
  only(...categories: Name[]): Detector;
  only(...args: [...Name[], ClassifierOnlyOptions]): Detector;
};

/**
 * A detector for rules only you can describe, judged by a model. Findings are labelled
 * `classifier.<category>`, or `classifier.<category>:<level>` with `levels`. `llm` must be a
 * `VernLLM` of its own. See the hosted detectors docs.
 */
export function llmClassifier<const Name extends string>(
  options: LLMClassifierOptions<Name>,
): ClassifierDetector<Name> {
  const { categories, quotes, levels, batchSize, settings, ...rest } =
    resolveClassifierOptions(options);

  return createHosted<Name>({
    name: CLASSIFIER_NAME,
    kinds: categories.map(([name]) => name as Name),
    // A label with levels ends in `:1` to `:3`, which is not part of the category.
    kindOf: (label) => label.slice(CLASSIFIER_PREFIX.length).replace(/:\d$/, ''),
    concurrency: settings.concurrency,
    cache: settings.cache,
    levels,
    analyze: createAnalyze({
      batchSize,
      chunkChars: settings.chunkChars,
      overlapChars: settings.overlapChars,
      request: createClassifierRequest({ categories, quotes, levels, ...rest }),
      hitsOf: (verdict, text) => hitsOf(verdict, text, quotes, levels),
    }),
  }) as ClassifierDetector<Name>;
}
