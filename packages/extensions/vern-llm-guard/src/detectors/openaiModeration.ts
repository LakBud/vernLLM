import { createGuard } from '../internal/guard.utils.js';
import { createAnalyze } from '../internal/hosted/analyze.js';
import { createHosted } from '../internal/hosted/instance.js';
import { hitsOf } from '../internal/moderation/hits.js';
import { withImages } from '../internal/moderation/images.js';
import { resolveModerationOptions } from '../internal/moderation/options.utils.js';
import {
  createModerationImageRequest,
  createModerationRequest,
} from '../internal/moderation/request.js';
import {
  MODERATION_CATEGORIES,
  MODERATION_NAME,
  MODERATION_PREFIX,
  type ModerationCategory,
  type OpenAIModerationOptions,
} from './openaiModeration.types.js';

import type { HostedDetector } from '../internal/hosted/types.js';

export { MODERATION_CATEGORIES } from './openaiModeration.types.js';
export type {
  ModerationCategory,
  ModerationClient,
  ModerationImagePart,
  ModerationResult,
  ModerationUsage,
  OpenAIModerationOptions,
} from './openaiModeration.types.js';

/**
 * A detector for harmful content, backed by OpenAI's Moderation API, which is free. A finding is
 * one category, labelled `moderation.<category>`, over a whole segment: the API returns no
 * positions, so these findings label and block, and a `redact` check on them blocks.
 *
 * `.only('self-harm', 'violence')` gives a detector for some categories that shares this one's
 * requests and cache, so several checks over one text cost one request.
 *
 * With `images: true` it also reads images, one request each, with the same whole segment
 * findings. Images are off by default.
 *
 * It sends the text, and the images when they are on, to OpenAI. A `-latest` model can change what it finds under the
 * memo, so pin a dated one to keep results stable.
 */
export function openaiModeration(
  options: OpenAIModerationOptions,
): HostedDetector<ModerationCategory> {
  const {
    client,
    model,
    batchSize,
    thresholds,
    limited,
    settings,
    report,
    images,
    unsupportedImages,
  } = resolveModerationOptions(options);

  if (model.endsWith('-latest')) {
    createGuard(options.logger).warn(
      `${MODERATION_NAME}: model "${model}" is an alias, so its results can change under the memo. To pin it, set model to a dated snapshot from the OpenAI models docs`,
    );
  }

  const text = createAnalyze({
    batchSize,
    chunkChars: settings.chunkChars,
    overlapChars: settings.overlapChars,
    request: createModerationRequest({ client, model, limited, report }),
    hitsOf: (result) => hitsOf(result, thresholds),
  });

  return createHosted<ModerationCategory>({
    name: MODERATION_NAME,
    kinds: MODERATION_CATEGORIES,
    kindOf: (label) => label.slice(MODERATION_PREFIX.length),
    concurrency: settings.concurrency,
    cache: settings.cache,
    images,
    analyze: images
      ? withImages({
          text,
          request: createModerationImageRequest({ client, model, limited, report }),
          hitsOf: (result) => hitsOf(result, thresholds),
          unsupported: unsupportedImages,
        })
      : text,
  });
}
