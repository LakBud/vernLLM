import { invalid } from './invalid.utils.js';
import { MIN_HOLD_CHARS, RELEASES, isRecord } from './settings.utils.js';
import { choice, integerAtLeast } from './validate.utils.js';

import type { GuardOptions } from '../../types/index.js';
import type { CompiledStream } from '../../types/resolvedConfig.js';

/** The stream options with defaults, checked together because they depend on each other. */
export function compileStream(options: GuardOptions): CompiledStream {
  const streamOptions = options.stream ?? {};
  if (!isRecord(streamOptions)) invalid('stream must be an object');

  const release = choice<CompiledStream['release']>(
    streamOptions.release,
    'checked',
    RELEASES,
    'stream.release',
  );
  const holdChars = integerAtLeast(
    streamOptions.holdChars,
    128,
    MIN_HOLD_CHARS,
    `stream.holdChars must be an integer of at least ${MIN_HOLD_CHARS}`,
  );
  const windowChars = integerAtLeast(
    streamOptions.windowChars,
    Math.max(1000, holdChars + 1),
    holdChars + 1,
    'stream.windowChars must be an integer larger than stream.holdChars',
  );

  return Object.freeze({ release, holdChars, windowChars });
}
