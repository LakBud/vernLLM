import type { Lookup } from './hosted/lookup.js';
import type { Ground } from './hosted/types.js';
import type {
  CallView,
  Finding,
  GroundingDetector,
  GroundingOptions,
  Segment,
  Source,
} from './types.js';

/** Bedrock's limits on a grounding request, in characters. */
export const MAX_SOURCE_CHARS = 100_000;
export const MAX_QUERY_CHARS = 1000;

const SOURCES: readonly Source[] = ['user', 'tool', 'system', 'assistant'];

export interface GroundingConfig {
  name: string;
  lookup: Lookup;
}

/** The text of the last user message, which is the question the answer should address. */
function lastQuestion(input: readonly Segment[]): string | undefined {
  return input.filter(({ source, text }) => source === 'user' && text.trim() !== '').at(-1)?.text;
}

/** Refuses options that could not work, once, when the view is built. */
function validate(name: string, sources: readonly Source[], queryOverflow: string): void {
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !sources.every((s) => SOURCES.includes(s))
  ) {
    throw new TypeError(
      `${name}: grounding sources must be a non empty list of user, tool, system or assistant`,
    );
  }
  if (queryOverflow !== 'tail' && queryOverflow !== 'error') {
    throw new TypeError(`${name}: queryOverflow must be 'tail' or 'error'`);
  }
}

/** The texts the answer must be grounded in, which Bedrock takes up to a total size. */
function sourceTexts(
  name: string,
  input: readonly Segment[],
  wanted: ReadonlySet<Source>,
): string[] {
  const texts = input
    .filter(({ source, text }) => wanted.has(source) && text.trim() !== '')
    .map(({ text }) => text);

  if (texts.reduce((total, text) => total + text.length, 0) > MAX_SOURCE_CHARS) {
    throw new Error(`${name}: the grounding sources are over ${MAX_SOURCE_CHARS} characters`);
  }
  return texts;
}

/** The question, cut to what Bedrock takes, or an error when it was asked to refuse a long one. */
function questionOf(
  name: string,
  input: readonly Segment[],
  queryOverflow: 'tail' | 'error',
): string | undefined {
  const question = lastQuestion(input);
  if (question === undefined || question.length <= MAX_QUERY_CHARS) return question;

  if (queryOverflow === 'error') {
    throw new Error(`${name}: the question is over ${MAX_QUERY_CHARS} characters`);
  }
  return question.slice(-MAX_QUERY_CHARS);
}

/** What the answer is judged against, or `undefined` when there is nothing to judge it by. */
function groundOf(
  name: string,
  input: readonly Segment[],
  wanted: ReadonlySet<Source>,
  queryOverflow: 'tail' | 'error',
): Ground | undefined {
  const texts = sourceTexts(name, input, wanted);
  if (texts.length === 0) return undefined;
  return { sources: texts, query: questionOf(name, input, queryOverflow) };
}

/**
 * Builds the grounding views of one detector. A view reads the call around the answer, so it only
 * runs as an output check, and it shares the detector's requests and cache: the cache key covers
 * the sources, the question and the text, since the verdict depends on all three.
 */
export function createGrounding({ name, lookup }: GroundingConfig) {
  return (options: GroundingOptions = {}): GroundingDetector => {
    const { sources = ['tool'], queryOverflow = 'tail' } = options;
    validate(name, sources, queryOverflow);
    const wanted: ReadonlySet<Source> = new Set(sources);

    const detect = async (
      segments: readonly Segment[],
      signal: AbortSignal,
      call?: CallView,
    ): Promise<Finding[]> => {
      if (call === undefined) {
        throw new TypeError(
          `${name}: grounding reads the call, so it only runs as an output check`,
        );
      }
      // No source, no check: without tool results there is nothing to be grounded in.
      const ground = groundOf(name, call.input, wanted, queryOverflow);
      if (ground === undefined) return [];

      const found = await lookup(
        segments.map((segment) => ({ ...segment, ground })),
        signal,
      );
      return found.flatMap((spans, segment) => spans.map((span) => ({ segment, ...span })));
    };

    return Object.assign(detect, { callView: true as const });
  };
}
