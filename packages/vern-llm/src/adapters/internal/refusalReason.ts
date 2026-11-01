/** The wire `refusal` for a stop reason, when it is one of the provider's refusal spellings. */
export function refusalReason(
  reason: string | null | undefined,
  refusalReasons: ReadonlySet<string>,
): { refusal?: string } {
  return reason && refusalReasons.has(reason) ? { refusal: reason } : {};
}
