import type { GenAiProviderName } from '../../types/index.js';

export function normalizeProviderNames(
  names: Readonly<Record<string, GenAiProviderName>> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (names === undefined) return map;

  if (typeof names !== 'object' || names === null || Array.isArray(names)) {
    throw new Error('otelMiddleware: providerNames must be an object');
  }

  for (const [label, value] of Object.entries(names)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`otelMiddleware: providerNames["${label}"] must be a non-empty string`);
    }
    map.set(label, value);
  }

  return map;
}

/** Value the semantic conventions reserve for a provider that is not known. */
export const UNKNOWN_PROVIDER = '_OTHER';

// Ordered: Bedrock ids embed a vendor name (`anthropic.claude...`), so they are matched first.
const MODEL_PATTERNS: readonly [RegExp, GenAiProviderName][] = [
  [
    /^(?:[a-z]{2,4}\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|writer)\.[\w.-]+:\d+$/i,
    'aws.bedrock',
  ],
  [
    /^(?:[a-z]{2,4}\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|writer)\.[\w.-]+-v\d/i,
    'aws.bedrock',
  ],
  // Vertex AI publishes Claude with an `@version` suffix, the Claude API does not.
  [/^claude[\w.-]*@/i, 'gcp.vertex_ai'],
  [/^claude/i, 'anthropic'],
  [/^(?:gpt|chatgpt|o\d|text-embedding|dall-e|whisper|tts)/i, 'openai'],
  [/^(?:models\/)?gemini/i, 'gcp.gemini'],
  [/^(?:mistral|mixtral|codestral|magistral|ministral|pixtral|devstral)/i, 'mistral_ai'],
  [/^grok/i, 'x_ai'],
  [/^deepseek/i, 'deepseek'],
  [/^command/i, 'cohere'],
  [/^sonar/i, 'perplexity'],
  [/^(?:kimi|moonshot)/i, 'moonshot_ai'],
];

/** Best guess of `gen_ai.provider.name` from a model id, `undefined` when nothing matches. */
export function inferProviderName(model: string): string | undefined {
  for (const [pattern, name] of MODEL_PATTERNS) {
    if (pattern.test(model)) return name;
  }
  return undefined;
}

/**
 * `gen_ai.provider.name` for an attempt: the configured mapping for the target label, else a
 * guess from the model, else `_OTHER`. The label itself (`primary`, `fallback[0]`) is never a
 * provider name, so it is not used.
 */
export function resolveProviderName(
  names: ReadonlyMap<string, string>,
  label: string,
  model: string,
): string {
  return names.get(label) ?? inferProviderName(model) ?? UNKNOWN_PROVIDER;
}
