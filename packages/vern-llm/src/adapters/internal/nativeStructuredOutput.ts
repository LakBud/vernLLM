/**
 * A static allow-list or predicate naming which models support native,
 * schema-constrained output as its own request field — Anthropic's
 * `output_config.format`, Bedrock's `outputConfig.textFormat` — separate
 * from `tools`/`tool_choice`, so it can be combined with real,
 * caller-supplied `tools` in the same request.
 *
 * There is no built-in default list here. Which models support this is
 * Anthropic's and Bedrock's call to make, not this package's, and it
 * changes over time; hardcoding a guessed list would risk silently
 * routing a request onto a field a given model doesn't actually support,
 * trading a clear `LLMError('validation')` for a confusing error from the
 * provider instead. So this is opt-in: pass the model IDs you've verified
 * against the provider's own docs (or a predicate). Left unset, no model
 * is treated as native-capable, `jsonSchema` keeps using the older
 * forced-single-tool-call emulation, and `tools` + `jsonSchema` together
 * is rejected, exactly this package's behavior before native support was
 * added.
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
