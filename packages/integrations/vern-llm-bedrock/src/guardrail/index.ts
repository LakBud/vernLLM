import { ConsoleLogger, type Logger } from 'vern-llm';

import { createAnalyze } from './analyze.js';
import { createLookup } from './hosted/lookup.js';
import { createView } from './hosted/view.js';
import { resolveOptions } from './options.js';
import { createRequest } from './request.js';
import { GUARDRAIL_KINDS, type BedrockGuardrailOptions, type GuardrailDetector } from './types.js';

export { GUARDRAIL_KINDS } from './types.js';
export type {
  BedrockGuardrailOptions,
  Detector,
  Finding,
  GuardrailClient,
  GuardrailDetector,
  GuardrailKind,
  GuardrailUsageInfo,
  Segment,
  Source,
} from './types.js';

const NAME = 'bedrockGuardrail';

/** Says a `DRAFT` guardrail can change under the cache, once, and never throws. */
function warnDraft(option: Logger | 'silent' | undefined): void {
  if (option === 'silent') return;
  try {
    (option ?? new ConsoleLogger(false)).warn(
      `[VernLLM] ${NAME}: guardrailVersion "DRAFT" can change at any time, so its results are not cached. Use a published version`,
    );
  } catch {
    // A throwing logger must not fail construction.
  }
}

/**
 * A detector backed by an Amazon Bedrock guardrail, run through `ApplyGuardrail`. It sends the text
 * it checks to Bedrock. Labels, options and caching are in the Bedrock guardrails docs.
 */
export function bedrockGuardrail(options: BedrockGuardrailOptions): GuardrailDetector {
  const settings = resolveOptions(NAME, options);
  const { client, guardrailIdentifier, guardrailVersion, report } = settings;
  const draft = guardrailVersion === 'DRAFT';

  if (draft) warnDraft(options.logger);

  return createView({
    name: NAME,
    kinds: GUARDRAIL_KINDS,
    kindOf: (label) => label.slice(0, label.indexOf('.')),
    lookup: createLookup({
      name: NAME,
      concurrency: settings.concurrency,
      cache: draft ? false : settings.cache,
      analyze: createAnalyze({
        chunkChars: settings.chunkChars,
        overlapChars: settings.overlapChars,
        ask: createRequest({ name: NAME, client, guardrailIdentifier, guardrailVersion, report }),
      }),
    }),
  });
}
