import {
  CLASSIFIER_NAME,
  type ClassifierAnswer,
  type ClassifierLLM,
  type ClassifierUsage,
} from '../../detectors/llmClassifier.types.js';
import { classifierCallState } from '../middleware/classifierCall.js';
import { buildContent, buildPrompt, pickBoundary } from './prompt.js';
import { answerSchema, createValidator } from './schema.js';

import type { CallMeta } from 'vern-llm';

export type Verdict = ClassifierAnswer['results'][number];

export type ClassifierRequest = (
  texts: string[],
  signal: AbortSignal,
) => Promise<readonly Verdict[]>;

export interface ClassifierRequestConfig {
  llm: ClassifierLLM;
  categories: readonly (readonly [name: string, description: string])[];
  instructions: string | undefined;
  quotes: boolean;
  levels: boolean;
  maxTokens: number;
  report: (info: ClassifierUsage) => void;
}

/** Orders verdicts by id, and throws unless each text has exactly one. */
function inOrder(results: readonly Verdict[], count: number): Verdict[] {
  if (results.length !== count) {
    throw new Error(`${CLASSIFIER_NAME}: the model answered for the wrong number of texts`);
  }

  const ordered: (Verdict | undefined)[] = Array.from({ length: count });
  for (const result of results) {
    if (result.id < 0 || result.id >= count || ordered[result.id] !== undefined) {
      throw new Error(
        `${CLASSIFIER_NAME}: the model answered for a text it was not sent, or twice`,
      );
    }
    ordered[result.id] = result;
  }
  return ordered as Verdict[];
}

/** One call to the model, with its answer checked against the texts sent. */
export function createClassifierRequest(config: ClassifierRequestConfig): ClassifierRequest {
  const { llm, categories, instructions, quotes, levels, maxTokens, report } = config;
  const names = categories.map(([name]) => name);
  const schema = answerSchema(names, quotes, levels);
  const validator = createValidator(names, quotes, levels);

  return async (texts, signal) => {
    signal.throwIfAborted();
    const boundary = pickBoundary(texts);
    const meta: { current?: CallMeta } = {};
    const started = performance.now();

    const answer = await llm.call({
      systemPrompt: buildPrompt({ categories, instructions, quotes, levels, boundary }),
      userContent: buildContent(texts, boundary),
      jsonMode: true,
      jsonSchema: { name: 'classification', schema, strict: true },
      schema: validator,
      temperature: 0,
      maxTokens,
      signal,
      state: classifierCallState,
      meta,
    });

    const checked = validator.safeParse(answer);
    if (!checked.success) {
      throw new Error(`${CLASSIFIER_NAME}: the model returned an answer that does not fit`);
    }
    const verdicts = inOrder(checked.data.results, texts.length);

    report({
      texts: texts.length,
      ms: Math.round(performance.now() - started),
      model: meta.current?.model,
    });
    return verdicts;
  };
}
