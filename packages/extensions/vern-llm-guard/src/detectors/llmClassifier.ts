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

import type { HostedDetector } from '../internal/hosted/types.js';

export type {
  ClassifierAnswer,
  ClassifierLLM,
  ClassifierUsage,
  LLMClassifierOptions,
} from './llmClassifier.types.js';

/**
 * A detector for rules only you can describe, judged by a model. Findings are labelled
 * `classifier.<category>`. `llm` must be a `VernLLM` of its own. See the hosted detectors docs.
 */
export function llmClassifier<const Name extends string>(
  options: LLMClassifierOptions<Name>,
): HostedDetector<Name> {
  const { categories, quotes, batchSize, settings, ...rest } = resolveClassifierOptions(options);

  return createHosted<Name>({
    name: CLASSIFIER_NAME,
    kinds: categories.map(([name]) => name as Name),
    kindOf: (label) => label.slice(CLASSIFIER_PREFIX.length),
    concurrency: settings.concurrency,
    cache: settings.cache,
    analyze: createAnalyze({
      batchSize,
      chunkChars: settings.chunkChars,
      overlapChars: settings.overlapChars,
      request: createClassifierRequest({ categories, quotes, ...rest }),
      hitsOf: (verdict, text) => hitsOf(verdict, text, quotes),
    }),
  });
}
