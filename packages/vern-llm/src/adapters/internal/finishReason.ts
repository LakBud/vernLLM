import type { FinishReason } from '../../types/index.js';

/** A provider's stop reason mapped onto `FinishReason`, or `'other'` when it has no entry. */
export function mapFinishReason(
  reason: string | null | undefined,
  map: Readonly<Record<string, FinishReason>>,
): FinishReason | undefined {
  return reason ? (map[reason] ?? 'other') : undefined;
}

/** The wire `finish_reason` for a provider's stop reason. */
export function finishReason(
  reason: string | null | undefined,
  map: Readonly<Record<string, FinishReason>>,
): { finish_reason?: FinishReason } {
  const mapped = mapFinishReason(reason, map);

  return mapped ? { finish_reason: mapped } : {};
}
