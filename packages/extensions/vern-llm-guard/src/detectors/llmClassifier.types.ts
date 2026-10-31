import type { HostedOptions } from '../internal/hosted/options.js';
import type { CallParams } from 'vern-llm';

/** Name used in errors. */
export const CLASSIFIER_NAME = 'llmClassifier';

/** Prefix of every label. */
export const CLASSIFIER_PREFIX = 'classifier.';

/** The answer asked of the model: one entry per text, by id. */
export interface ClassifierAnswer {
  results: {
    id: number;
    /** With `levels`, the categories at level 1 or above. */
    categories: string[];
    /** Only with `levels`: every category's level, 0 none, 1 low, 2 medium, 3 high. */
    levels?: { [category: string]: number };
    /** Exact text behind each category. Only with `quotes`. */
    quotes?: { [category: string]: string[] };
  }[];
}

/** Just the `call` of a `VernLLM`. Must not be the instance a guard protects. */
export interface ClassifierLLM {
  call(params: CallParams<ClassifierAnswer>): PromiseLike<unknown>;
}

/** What one call to the model cost. */
export interface ClassifierUsage {
  /** Texts in the call. */
  texts: number;
  /** Milliseconds. */
  ms: number;
  /** The answering model, when known. */
  model: string | undefined;
}

export interface LLMClassifierOptions<Name extends string = string> extends HostedOptions {
  /** A `VernLLM` of its own. */
  llm: ClassifierLLM;
  /** `{ [name]: description }`. Names are `[a-z0-9_]`, 1 to 40 characters. */
  categories: { [K in Name]: string };
  /** Extra guidance put before the fixed prompt. */
  instructions?: string;
  /** Ask for quotes, so findings get spans. Default `false`. */
  quotes?: boolean;
  /**
   * Ask for a level per category, 0 none, 1 low, 2 medium, 3 high, so `only(...kinds, { minLevel })`
   * can act on how strong a finding is. A label then ends in its level, such as
   * `classifier.advice:2`. It changes the prompt and the answers, so give the guard a new
   * `version`. Default `false`.
   */
  levels?: boolean;
  /** Texts per call, 1 to 16. Default `1`. */
  batchSize?: number;
  /** Default `300`. */
  maxTokens?: number;
  onUsage?: (info: ClassifierUsage) => void;
}
