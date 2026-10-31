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
 * A detector backed by an Amazon Bedrock guardrail, run through `ApplyGuardrail`: topics, content
 * filters, sensitive information, regexes and word lists you manage in AWS. A finding is labeled
 * `pii.<type>`, `regex.<name>`, `word.<type>`, `topic.<name>` or `content.<type>`. Matches in
 * sensitive information and word policies are located in the text and give spans. Topic and
 * content findings cover the whole text.
 *
 * It makes one request per text, shared by every view, and the guardrail's own action is ignored:
 * what to do with a finding is up to the caller. `.only('pii', 'regex')` gives a detector for some
 * kinds over the same requests and cache.
 *
 * It sends the text it checks to Bedrock. A `DRAFT` version can change at any time, so it warns
 * once and turns the cache off.
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
