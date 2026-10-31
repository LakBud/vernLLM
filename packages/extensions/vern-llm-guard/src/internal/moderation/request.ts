import {
  MODERATION_NAME,
  type ModerationClient,
  type ModerationImagePart,
  type ModerationResult,
  type ModerationUsage,
} from '../../detectors/openaiModeration.types.js';

/** Sends texts to the provider in one request, and returns one result per text. */
export type ModerationRequest = (
  texts: string[],
  signal: AbortSignal,
) => Promise<readonly ModerationResult[]>;

/** Sends one image to the provider, and returns its result. */
export type ModerationImageRequest = (
  image: { data: string; mimeType: string },
  signal: AbortSignal,
) => Promise<ModerationResult>;

export interface ModerationRequestConfig {
  client: ModerationClient;
  model: string;
  /** Whether a threshold reads the scores, so a result without them is unusable. */
  limited: boolean;
  report: (info: ModerationUsage) => void;
}

/** Whether the results are what was asked for: one per input, each with what the detector reads. */
function checked(
  results: unknown,
  count: number,
  limited: boolean,
  noun: 'texts' | 'images',
): readonly ModerationResult[] {
  // Never guess which result belongs to which input.
  if (!Array.isArray(results) || results.length !== count) {
    throw new Error(`${MODERATION_NAME}: the API answered for the wrong number of ${noun}`);
  }
  for (const result of results as (Partial<ModerationResult> | null)[]) {
    if (typeof result?.categories !== 'object' || result.categories === null) {
      throw new Error(`${MODERATION_NAME}: the API returned a result without categories`);
    }
    // A threshold reads the scores, and a missing one must not quietly let anything through.
    if (
      limited &&
      (typeof result.category_scores !== 'object' || result.category_scores === null)
    ) {
      throw new Error(`${MODERATION_NAME}: the API returned a result without scores`);
    }
  }
  return results as readonly ModerationResult[];
}

/** The one request both kinds share: send, check the answer against what was sent, report. */
function sender(config: ModerationRequestConfig) {
  const { client, model, limited, report } = config;

  return async (
    input: string[] | ModerationImagePart[],
    signal: AbortSignal,
    usage: Pick<ModerationUsage, 'texts' | 'images'>,
  ): Promise<readonly ModerationResult[]> => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await client.moderations.create({ model, input }, { signal });
    const results = checked(
      response.results,
      input.length,
      limited,
      usage.images ? 'images' : 'texts',
    );
    report({ model, ...usage, ms: Math.round(performance.now() - started) });
    return results;
  };
}

/**
 * One request to the Moderation API, checked against the texts that were sent. Results are only
 * accepted in the same number and shape, so a failure never quietly lets text through.
 */
export function createModerationRequest(config: ModerationRequestConfig): ModerationRequest {
  const send = sender(config);
  return (texts, signal) => send(texts, signal, { texts: texts.length });
}

/**
 * One request for one image. A multimodal input returns a single result for all its parts, so
 * images cannot share a request and still be told apart: each is sent alone.
 */
export function createModerationImageRequest(
  config: ModerationRequestConfig,
): ModerationImageRequest {
  const send = sender(config);

  return async ({ data, mimeType }, signal) => {
    const part: ModerationImagePart = {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${data}` },
    };
    const [result] = await send([part], signal, { texts: 0, images: 1 });
    return result!;
  };
}
