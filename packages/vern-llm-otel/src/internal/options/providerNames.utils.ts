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
