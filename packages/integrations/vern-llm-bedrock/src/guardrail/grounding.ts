import type { Lookup } from './hosted/lookup.js';
import type { Ground } from './hosted/types.js';
import type { Finding, GroundingDetector, GroundingOptions, Segment, Source } from './types.js';

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

/**
 * Builds the grounding views of one detector. A view reads the call around the answer, so it only
 * runs as an output check, and it shares the detector's requests and cache: the cache key covers
 * the sources, the question and the text, since the verdict depends on all three.
 */
export function createGrounding(config: GroundingConfig) {
  const { name, lookup } = config;

  return (options: GroundingOptions = {}): GroundingDetector => {
    const { sources = ['tool'], queryOverflow = 'tail' } = options;

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

    /** What the answer is judged against, or `undefined` when there is nothing to judge it by. */
    const groundOf = (input: readonly Segment[]): Ground | undefined => {
      const texts = input
        .filter(({ source, text }) => sources.includes(source as never) && text.trim() !== '')
        .map(({ text }) => text);
      if (texts.length === 0) return undefined;

      if (texts.reduce((total, text) => total + text.length, 0) > MAX_SOURCE_CHARS) {
        throw new Error(`${name}: the grounding sources are over ${MAX_SOURCE_CHARS} characters`);
      }
      const question = lastQuestion(input);
      if (question === undefined || question.length <= MAX_QUERY_CHARS) {
        return { sources: texts, query: question };
      }
      if (queryOverflow === 'error') {
        throw new Error(`${name}: the question is over ${MAX_QUERY_CHARS} characters`);
      }
      return { sources: texts, query: question.slice(-MAX_QUERY_CHARS) };
    };

    const detect = async (
      segments: readonly Segment[],
      signal: AbortSignal,
      call?: Parameters<GroundingDetector>[2],
    ): Promise<Finding[]> => {
      if (call === undefined) {
        throw new TypeError(
          `${name}: grounding reads the call, so it only runs as an output check`,
        );
      }
      // No source, no check: without tool results there is nothing to be grounded in.
      const ground = groundOf(call.input);
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
