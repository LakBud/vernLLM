import type { HostedOptions } from '../internal/hosted/options.js';

/** The name errors and warnings use. */
export const MODERATION_NAME = 'openaiModeration';

/** The prefix of every label the detector reports. */
export const MODERATION_PREFIX = 'moderation.';

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
