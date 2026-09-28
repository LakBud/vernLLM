/**
 * The wire `finish_reason` for a provider's stop reason. Core only acts on
 * truncation, so `lengthReason`, the provider's own spelling of it, maps to
 * `'length'` and every other reason is left off.
 */
export function finishReason(
  reason: string | null | undefined,
  lengthReason: string,
): { finish_reason?: 'length' } {
  return reason === lengthReason ? { finish_reason: 'length' } : {};
}
