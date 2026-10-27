import { createGuard } from '../internal/guard.utils.js';
import { mergeSpans, splitText } from '../internal/hosted/chunks.js';
import { createHosted, type Hit, type HostedDetector } from '../internal/hosted/instance.js';
import { hostedSettings, usageReporter, type HostedOptions } from '../internal/hosted/options.js';

/** The categories OpenAI's moderation models return. */
export const MODERATION_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** What the detector reads of one result. The OpenAI SDK's `Moderation` fits. */
export interface ModerationResult {
  flagged?: boolean;
  categories: { [K in ModerationCategory]?: boolean | null };
  category_scores?: { [K in ModerationCategory]?: number | null };
}

/** Just what the detector needs of a client. An `OpenAI` instance fits. */
export interface ModerationClient {
  moderations: {
    create(
      body: { model: string; input: string[] },
      options?: { signal?: AbortSignal },
    ): PromiseLike<{ results: readonly ModerationResult[] }>;
  };
}

/** What one request to the Moderation API cost. The API itself is free. */
export interface ModerationUsage {
  model: string;
  /** Texts in the request. */
  texts: number;
  /** Milliseconds the request took. */
  ms: number;
}

export interface OpenAIModerationOptions extends HostedOptions {
  client: ModerationClient;
  /** Default `'omni-moderation-latest'`. Pin a dated model to keep results stable under the memo. */
  model?: string;
  /**
   * A category counts when its score is at or above its threshold, instead of OpenAI's own flag.
   * Categories without one use the flag.
   */
  thresholds?: { [K in ModerationCategory]?: number };
  /** Texts per request, 1 to 256. Default 32. */
  batchSize?: number;
  onUsage?: (info: ModerationUsage) => void;
}

const NAME = 'openaiModeration';
const PREFIX = 'moderation.';

/** Moderation results come back with no positions, so findings have no span. */
const labelOf = (category: string): string => `${PREFIX}${category}`;

function validate(options: OpenAIModerationOptions): void {
  const { client, model, thresholds, batchSize } = options;

  if (typeof client?.moderations?.create !== 'function') {
    throw new TypeError(`${NAME}: client.moderations.create must be a function`);
  }
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    throw new TypeError(`${NAME}: model must be a non empty string`);
  }
  if (
    batchSize !== undefined &&
    !(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 256)
  ) {
    throw new TypeError(`${NAME}: batchSize must be an integer from 1 to 256`);
  }
  if (thresholds === undefined) return;

  for (const [category, limit] of Object.entries(thresholds)) {
    if (!MODERATION_CATEGORIES.includes(category as ModerationCategory)) {
      throw new TypeError(`${NAME}: thresholds has an unknown category "${category}"`);
    }
    if (typeof limit !== 'number' || !(limit >= 0 && limit <= 1)) {
      throw new TypeError(`${NAME}: the threshold for "${category}" must be a number from 0 to 1`);
    }
  }
}

/**
 * A detector for harmful content, backed by OpenAI's Moderation API, which is free. A finding is
 * one category, labelled `moderation.<category>`, over a whole segment: the API returns no
 * positions, so these findings label and block, and a `redact` check on them blocks.
 *
 * `.only('self-harm', 'violence')` gives a detector for some categories that shares this one's
 * requests and cache, so several checks over one text cost one request.
 *
 * It sends the text it checks to OpenAI. A `-latest` model can change what it finds under the
 * memo, so pin a dated one to keep results stable.
 */
export function openaiModeration(
  options: OpenAIModerationOptions,
): HostedDetector<ModerationCategory> {
  validate(options);

  const { client, model = 'omni-moderation-latest', batchSize = 32, thresholds = {} } = options;
  const settings = hostedSettings(NAME, options, { chunkChars: 8000, overlapChars: 200 });
  const report = usageReporter(NAME, options.onUsage);

  if (model.endsWith('-latest')) {
    createGuard(options.logger).warn(
      `${NAME}: model "${model}" is an alias, so its results can change under the memo. Pin a dated model`,
    );
  }

  const limited = Object.keys(thresholds).length > 0;
  const counts = (result: ModerationResult, category: string): boolean => {
    const limit = thresholds[category as ModerationCategory];
    if (limit === undefined) return result.categories[category as ModerationCategory] === true;
    return (result.category_scores?.[category as ModerationCategory] ?? -1) >= limit;
  };

  const request = async (
    texts: string[],
    signal: AbortSignal,
  ): Promise<readonly ModerationResult[]> => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await client.moderations.create({ model, input: texts }, { signal });
    const results: unknown = response.results;

    // Never guess which result belongs to which text.
    if (!Array.isArray(results) || results.length !== texts.length) {
      throw new Error(`${NAME}: the API answered for the wrong number of texts`);
    }
    for (const result of results as (Partial<ModerationResult> | null)[]) {
      if (typeof result?.categories !== 'object' || result.categories === null) {
        throw new Error(`${NAME}: the API returned a result without categories`);
      }
      // A threshold reads the scores, and a missing one must not quietly let text through.
      if (
        limited &&
        (typeof result.category_scores !== 'object' || result.category_scores === null)
      ) {
        throw new Error(`${NAME}: the API returned a result without scores`);
      }
    }
    report({ model, texts: texts.length, ms: Math.round(performance.now() - started) });
    return results as readonly ModerationResult[];
  };

  return createHosted<ModerationCategory>({
    name: NAME,
    kinds: MODERATION_CATEGORIES,
    kindOf: (label) => label.slice(PREFIX.length),
    concurrency: settings.concurrency,
    cache: settings.cache,
    async analyze(segments, signal, limit) {
      // One entry per chunk of every text that has anything in it.
      const inputs = segments.flatMap((segment, index) =>
        segment.text.trim() === ''
          ? []
          : splitText(segment.text, settings.chunkChars, settings.overlapChars).map((chunk) => ({
              segment: index,
              ...chunk,
            })),
      );

      const batches: (typeof inputs)[] = [];
      for (let at = 0; at < inputs.length; at += batchSize) {
        batches.push(inputs.slice(at, at + batchSize));
      }

      const answered = await Promise.all(
        batches.map((batch) =>
          limit(() =>
            request(
              batch.map((input) => input.text),
              signal,
            ),
          ),
        ),
      );
      const results = answered.flat();

      const parts = segments.map(() => [] as { offset: number; spans: Hit[] }[]);
      inputs.forEach((input, at) => {
        const result = results[at]!;
        const names = new Set([...MODERATION_CATEGORIES, ...Object.keys(result.categories)]);
        const spans = [...names]
          .filter((name) => counts(result, name))
          .map((name) => ({ label: labelOf(name) }));
        parts[input.segment]!.push({ offset: input.offset, spans });
      });

      return parts.map((part) => mergeSpans(part));
    },
  });
}
