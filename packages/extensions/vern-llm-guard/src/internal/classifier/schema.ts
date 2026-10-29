import type { ClassifierAnswer } from '../../detectors/llmClassifier.types.js';
import type { SchemaLike } from 'vern-llm';

/** The provider's strict JSON Schema. Categories are an enum. */
export function answerSchema(names: readonly string[], quotes: boolean): Record<string, unknown> {
  const entry = {
    type: 'object',
    additionalProperties: false,
    required: quotes ? ['id', 'categories', 'quotes'] : ['id', 'categories'],
    properties: {
      id: { type: 'integer' },
      categories: { type: 'array', items: { type: 'string', enum: [...names] } },
      ...(quotes && {
        quotes: {
          type: 'object',
          additionalProperties: false,
          required: [...names],
          properties: Object.fromEntries(
            names.map((name) => [name, { type: 'array', items: { type: 'string' } }]),
          ),
        },
      }),
    },
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: { results: { type: 'array', items: entry } },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Why an answer does not fit. Never quotes it. */
function problemWith(
  data: unknown,
  names: ReadonlySet<string>,
  quotes: boolean,
): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.results)) return 'results must be an array';

  for (const [at, result] of data.results.entries()) {
    const where = `results[${at}]`;
    if (!isRecord(result)) return `${where} must be an object`;
    if (!Number.isInteger(result.id)) return `${where}.id must be an integer`;
    if (!isStrings(result.categories) || !result.categories.every((name) => names.has(name))) {
      return `${where}.categories must list only the categories given`;
    }
    if (!quotes) continue;

    if (!isRecord(result.quotes)) return `${where}.quotes must be an object`;
    for (const [name, found] of Object.entries(result.quotes)) {
      if (!names.has(name) || !isStrings(found)) {
        return `${where}.quotes must be lists of text, by category given`;
      }
    }
  }
  return undefined;
}

/** A hand written validator, so no schema library is needed. */
export function createValidator(
  names: readonly string[],
  quotes: boolean,
): SchemaLike<ClassifierAnswer> {
  const known = new Set(names);

  return {
    safeParse(data) {
      const problem = problemWith(data, known, quotes);
      return problem === undefined
        ? { success: true, data: data as ClassifierAnswer }
        : { success: false, error: new Error(problem) };
    },
  };
}
