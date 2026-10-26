import { reportedNanoUsd, tokenKinds, totalTokens } from '../pricing/charge.utils.js';

import type { UsagePricer } from '../pricing/usagePricer.utils.js';
import type { CallRecorder } from './callRecorder.js';
import type { VernLLMEvent } from 'vern-llm';

/** Maps one event to a charge on the recorder. Only the usage events carry one. */
export function applyEvent(recorder: CallRecorder, event: VernLLMEvent, price: UsagePricer): void {
  if (event.kind !== 'usage' && event.kind !== 'usage_failure') return;

  // What the provider billed beats a price computed from the token counts.
  const reported = reportedNanoUsd(event.usage.costUsd);
  recorder.charge(
    reported ?? price(event.usage),
    event.kind === 'usage_failure',
    totalTokens(event.usage),
    {
      provider: event.usage.provider,
      model: event.usage.model,
      kinds: tokenKinds(event.usage),
      reported: reported !== undefined,
      ...(event.chain !== undefined && { chain: event.chain }),
    },
  );
}
