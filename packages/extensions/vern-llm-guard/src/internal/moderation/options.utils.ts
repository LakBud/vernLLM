import {
  MODERATION_CATEGORIES,
  MODERATION_NAME,
  type ModerationCategory,
  type ModerationClient,
  type ModerationUsage,
  type OpenAIModerationOptions,
} from '../../detectors/openaiModeration.types.js';
import { hostedSettings, usageReporter, type HostedSettings } from '../hosted/options.js';

/** The options of one detector, checked and with every default filled in. */
export interface ModerationSettings {
  client: ModerationClient;
  model: string;
  batchSize: number;
  thresholds: { [K in ModerationCategory]?: number };
  /** Whether any category counts by score, so every result needs its scores. */
  limited: boolean;
  settings: HostedSettings;
  report: (info: ModerationUsage) => void;
}

/** Checks the detector's own options and fills in what was left out. */
export function resolveModerationOptions(options: OpenAIModerationOptions): ModerationSettings {
  validate(options);

  const { client, model = 'omni-moderation-latest', batchSize = 32, thresholds = {} } = options;
  return {
    client,
    model,
    batchSize,
    thresholds,
    limited: Object.keys(thresholds).length > 0,
    settings: hostedSettings(MODERATION_NAME, options, { chunkChars: 8000, overlapChars: 200 }),
    report: usageReporter(MODERATION_NAME, options.onUsage),
  };
}

function validate(options: OpenAIModerationOptions): void {
  const { client, model, thresholds, batchSize } = options;

  if (typeof client?.moderations?.create !== 'function') {
    throw new TypeError(`${MODERATION_NAME}: client.moderations.create must be a function`);
  }
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    throw new TypeError(`${MODERATION_NAME}: model must be a non empty string`);
  }
  if (
    batchSize !== undefined &&
    !(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 256)
  ) {
    throw new TypeError(`${MODERATION_NAME}: batchSize must be an integer from 1 to 256`);
  }
  if (thresholds === undefined) return;

  for (const [category, limit] of Object.entries(thresholds)) {
    if (!MODERATION_CATEGORIES.includes(category as ModerationCategory)) {
      throw new TypeError(`${MODERATION_NAME}: thresholds has an unknown category "${category}"`);
    }
    if (typeof limit !== 'number' || !(limit >= 0 && limit <= 1)) {
      throw new TypeError(
        `${MODERATION_NAME}: the threshold for "${category}" must be a number from 0 to 1`,
      );
    }
  }
}
