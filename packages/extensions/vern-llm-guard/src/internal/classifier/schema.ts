import type { ClassifierAnswer } from '../../detectors/llmClassifier.types.js';
import type { SchemaLike } from 'vern-llm';

/** The levels a category can have: none, low, medium, high. */
const LEVELS = [0, 1, 2, 3] as const;

/** The provider's strict JSON Schema. Categories are an enum, or with levels, a level each. */
export function answerSchema(
  names: readonly string[],
  quotes: boolean,
  levels = false,
): Record<string, unknown> {
  const judged = levels
    ? {
        levels: {
          type: 'object',
          additionalProperties: false,
          required: [...names],
          properties: Object.fromEntries(
            names.map((name) => [name, { type: 'integer', enum: [...LEVELS] }]),
          ),
        },
      }
    : { categories: { type: 'array', items: { type: 'string', enum: [...names] } } };

  const entry = {
    type: 'object',
    additionalProperties: false,
    required: ['id', levels ? 'levels' : 'categories', ...(quotes ? ['quotes'] : [])],
    properties: {
      id: { type: 'integer' },
      ...judged,
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

const isLevel = (value: unknown): boolean =>
  typeof value === 'number' && (LEVELS as readonly number[]).includes(value);

/** Why a result's levels do not fit: one of each category given, each from 0 to 3. */
function problemWithLevels(
  result: Record<string, unknown>,
  names: ReadonlySet<string>,
  where: string,
): string | undefined {
  const { levels } = result;
  if (!isRecord(levels)) return `${where}.levels must be an object`;

  const given = Object.entries(levels);
  if (given.some(([name, level]) => !names.has(name) || !isLevel(level))) {
    return `${where}.levels must be a level from 0 to 3, by category given`;
  }
  if (given.length !== names.size) return `${where}.levels must give every category a level`;
  return undefined;
}

/** Why an answer does not fit. Never quotes it. */
function problemWith(
  data: unknown,
  names: ReadonlySet<string>,
  quotes: boolean,
  levels: boolean,
): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.results)) return 'results must be an array';

  for (const [at, result] of data.results.entries()) {
    const where = `results[${at}]`;
    if (!isRecord(result)) return `${where} must be an object`;
    if (!Number.isInteger(result.id)) return `${where}.id must be an integer`;

    if (levels) {
      const problem = problemWithLevels(result, names, where);
      if (problem !== undefined) return problem;
    } else if (
      !isStrings(result.categories) ||
      !result.categories.every((name) => names.has(name))
    ) {
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

/**
 * With levels, the categories at level 1 or above, in the order they were given, so every result
 * has the same `categories` whichever way the model was asked.
 */
function withCategories(data: ClassifierAnswer, names: readonly string[]): ClassifierAnswer {
  return {
    ...data,
    results: data.results.map((result) => ({
      ...result,
      categories: names.filter((name) => result.levels![name]! >= 1),
    })),
  };
}

/** A hand written validator, so no schema library is needed. */
export function createValidator(
  names: readonly string[],
  quotes: boolean,
  levels = false,
): SchemaLike<ClassifierAnswer> {
  const known = new Set(names);

  return {
    safeParse(data) {
      const problem = problemWith(data, known, quotes, levels);
      if (problem !== undefined) return { success: false, error: new Error(problem) };
      const answer = data as ClassifierAnswer;
      return { success: true, data: levels ? withCategories(answer, names) : answer };
    },
  };
}
