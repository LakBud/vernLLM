import type { FinishReason } from '../../../../types/index.js';

const KNOWN: ReadonlySet<string> = new Set<FinishReason>([
  'stop',
  'length',
  'tool_calls',
  'refusal',
  'guardrail',
  'content_filter',
  'other',
]);

/**
 * Maps a wire `finish_reason` onto `FinishReason`. Adapters send the shared names, and OpenAI's
 * own values are the same apart from the legacy `function_call`. A provider refusal that came back
 * with a plain stop is reported as `'refusal'`.
 */
export function toFinishReason(
  reason: string | null | undefined,
  refused = false,
): FinishReason | undefined {
  const mapped = !reason ? undefined : reason === 'function_call' ? 'tool_calls' : reason;
  const known =
    mapped === undefined ? undefined : KNOWN.has(mapped) ? (mapped as FinishReason) : 'other';

  return refused && (known === undefined || known === 'stop') ? 'refusal' : known;
}
