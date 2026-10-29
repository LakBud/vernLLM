import {
  CLASSIFIER_NAME,
  type ClassifierLLM,
  type ClassifierUsage,
  type LLMClassifierOptions,
} from '../../detectors/llmClassifier.types.js';
import { hostedSettings, usageReporter, type HostedSettings } from '../hosted/options.js';

const NAME_PATTERN = /^[a-z0-9_]{1,40}$/;

/** Checked options with defaults. */
export interface ClassifierSettings {
  llm: ClassifierLLM;
  categories: readonly (readonly [name: string, description: string])[];
  instructions: string | undefined;
  quotes: boolean;
  batchSize: number;
  maxTokens: number;
  settings: HostedSettings;
  report: (info: ClassifierUsage) => void;
}

export function resolveClassifierOptions(options: LLMClassifierOptions): ClassifierSettings {
  validate(options);

  const { llm, instructions, quotes = false, batchSize = 1, maxTokens = 300 } = options;
  return {
    llm,
    categories: Object.entries(options.categories),
    instructions: instructions === '' ? undefined : instructions,
    quotes,
    batchSize,
    maxTokens,
    settings: hostedSettings(CLASSIFIER_NAME, options, { chunkChars: 16_000, overlapChars: 200 }),
    report: usageReporter(CLASSIFIER_NAME, options.onUsage),
  };
}

function validate(options: LLMClassifierOptions): void {
  const { llm, categories, instructions, quotes, batchSize, maxTokens } = options;

  if (typeof llm?.call !== 'function') {
    throw new TypeError(`${CLASSIFIER_NAME}: llm.call must be a function`);
  }
  validateCategories(categories);

  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new TypeError(`${CLASSIFIER_NAME}: instructions must be a string`);
  }
  if (quotes !== undefined && typeof quotes !== 'boolean') {
    throw new TypeError(`${CLASSIFIER_NAME}: quotes must be a boolean`);
  }
  if (
    batchSize !== undefined &&
    !(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 16)
  ) {
    throw new TypeError(`${CLASSIFIER_NAME}: batchSize must be an integer from 1 to 16`);
  }
  if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && maxTokens >= 1)) {
    throw new TypeError(`${CLASSIFIER_NAME}: maxTokens must be a positive integer`);
  }
}

function validateCategories(categories: unknown): void {
  const entries =
    typeof categories === 'object' && categories !== null && !Array.isArray(categories)
      ? Object.entries(categories)
      : [];
  if (entries.length === 0) {
    throw new TypeError(
      `${CLASSIFIER_NAME}: categories must be an object with at least one category`,
    );
  }

  for (const [name, description] of entries) {
    if (!NAME_PATTERN.test(name)) {
      throw new TypeError(
        `${CLASSIFIER_NAME}: the category name "${name}" must match [a-z0-9_] and be 1 to 40 characters`,
      );
    }
    if (typeof description !== 'string' || description.trim() === '') {
      throw new TypeError(
        `${CLASSIFIER_NAME}: the description of category "${name}" must be a non empty string`,
      );
    }
  }
}
