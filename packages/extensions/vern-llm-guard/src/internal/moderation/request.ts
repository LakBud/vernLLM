import {
  MODERATION_NAME,
  type ModerationClient,
  type ModerationResult,
  type ModerationUsage,
} from '../../detectors/openaiModeration.types.js';

/** Sends texts to the provider in one request, and returns one result per text. */
export type ModerationRequest = (
  texts: string[],
  signal: AbortSignal,
) => Promise<readonly ModerationResult[]>;

export interface ModerationRequestConfig {
  client: ModerationClient;
  model: string;
  /** Whether a threshold reads the scores, so a result without them is unusable. */
  limited: boolean;
  report: (info: ModerationUsage) => void;
}

/**
 * One request to the Moderation API, checked against the texts that were sent. Results are only
 * accepted in the same number and shape, so a failure never quietly lets text through.
 */
export function createModerationRequest(config: ModerationRequestConfig): ModerationRequest {
  const { client, model, limited, report } = config;

  return async (texts, signal) => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await client.moderations.create({ model, input: texts }, { signal });
    const results: unknown = response.results;

    // Never guess which result belongs to which text.
    if (!Array.isArray(results) || results.length !== texts.length) {
      throw new Error(`${MODERATION_NAME}: the API answered for the wrong number of texts`);
    }
    for (const result of results as (Partial<ModerationResult> | null)[]) {
      if (typeof result?.categories !== 'object' || result.categories === null) {
        throw new Error(`${MODERATION_NAME}: the API returned a result without categories`);
      }
      // A threshold reads the scores, and a missing one must not quietly let text through.
      if (
        limited &&
        (typeof result.category_scores !== 'object' || result.category_scores === null)
      ) {
        throw new Error(`${MODERATION_NAME}: the API returned a result without scores`);
      }
    }
    report({ model, texts: texts.length, ms: Math.round(performance.now() - started) });
    return results as readonly ModerationResult[];
  };
}
