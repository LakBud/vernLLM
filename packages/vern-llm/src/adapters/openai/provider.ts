/** Hosts whose provider is unambiguous. A gateway or proxy host is never listed. */
const PROVIDER_BY_HOST: ReadonlyArray<[RegExp, string]> = [
  [/^api\.openai\.com$/, 'openai'],
  [/\.openai\.azure\.com$/, 'azure.ai.openai'],
  [/^api\.groq\.com$/, 'groq'],
  [/^api\.mistral\.ai$/, 'mistral_ai'],
  [/^api\.deepseek\.com$/, 'deepseek'],
  [/^api\.x\.ai$/, 'x_ai'],
  [/^api\.perplexity\.ai$/, 'perplexity'],
];

/** The provider for an OpenAI compatible client, from the option or its `baseURL`. */
export function openAICompatibleProvider(
  client: unknown,
  provider: string | undefined,
): string | undefined {
  if (typeof provider === 'string' && provider.trim() !== '') return provider;

  const baseURL = (client as { baseURL?: unknown }).baseURL;
  if (typeof baseURL !== 'string') return undefined;

  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  return PROVIDER_BY_HOST.find(([pattern]) => pattern.test(host))?.[1];
}
