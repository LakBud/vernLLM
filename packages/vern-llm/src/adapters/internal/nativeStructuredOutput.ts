/**
 * A list of model ids, or a predicate, naming models with a capability.
 * Native structured output has no built in list: which models support it
 * is the provider's call and changes over time, and a wrong guess would
 * trade a clear local error for a confusing provider one.
 */
export type ModelCapabilityOverride = string[] | ((model: string) => boolean);

/** Resolves whether `model` is covered by a caller-supplied allow-list/predicate. */
export function supportsNativeStructuredOutput(
  model: string,
  override?: ModelCapabilityOverride,
): boolean {
  if (!override) return false;

  return Array.isArray(override) ? override.includes(model) : override(model);
}
