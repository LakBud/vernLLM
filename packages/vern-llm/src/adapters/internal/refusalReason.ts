/**
 * The wire `refusal` for a provider's stop reason. `refusalReasons` holds the provider's own
 * spellings of a refusal, and the matched reason is the value. Core only acts on it when the
 * response has no content and no tool calls, so a partial answer is still returned.
 */
export function refusalReason(
  reason: string | null | undefined,
  refusalReasons: ReadonlySet<string>,
): { refusal?: string } {
  return reason && refusalReasons.has(reason) ? { refusal: reason } : {};
}
