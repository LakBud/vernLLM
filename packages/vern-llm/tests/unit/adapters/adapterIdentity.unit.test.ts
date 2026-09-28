import { describe, expect, it } from 'vitest';

import {
  fromAnthropic,
  fromFetch,
  fromGemini,
  fromOpenAICompatible,
  type AnthropicClient,
  type GeminiClient,
} from '../../../src/adapters/index.js';

function openAIClient(baseURL?: unknown) {
  return {
    ...(baseURL === undefined ? {} : { baseURL }),
    chat: { completions: { create: async () => ({}) } },
  };
}

const models = { generateContent: async () => ({}) } as unknown as GeminiClient['models'];

describe('adapter identity', () => {
  it('names the fixed provider adapters', () => {
    expect(
      fromAnthropic({ messages: { create: async () => ({}) } } as unknown as AnthropicClient)
        .adapter,
    ).toEqual({
      name: 'anthropic',
      provider: 'anthropic',
    });
  });

  it('reads Vertex AI or the Gemini API off the client, and claims nothing when vertexai is unset', () => {
    expect(fromGemini({ models, vertexai: true }).adapter).toEqual({
      name: 'gemini',
      provider: 'gcp.vertex_ai',
    });
    expect(fromGemini({ models, vertexai: false }).adapter).toEqual({
      name: 'gemini',
      provider: 'gcp.gemini',
    });
    expect(fromGemini({ models }).adapter).toEqual({ name: 'gemini' });
  });

  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://my-resource.openai.azure.com/openai', 'azure.ai.openai'],
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://api.mistral.ai/v1', 'mistral_ai'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.x.ai/v1', 'x_ai'],
    ['https://api.perplexity.ai', 'perplexity'],
  ])('infers the provider from baseURL %s', (baseURL, provider) => {
    expect(fromOpenAICompatible(openAIClient(baseURL)).adapter).toEqual({
      name: 'openai-compatible',
      provider,
    });
  });

  it('claims no provider for a gateway, an unparsable, or a missing baseURL', () => {
    for (const baseURL of ['https://openrouter.ai/api/v1', 'not a url', 42, undefined]) {
      expect(fromOpenAICompatible(openAIClient(baseURL)).adapter).toEqual({
        name: 'openai-compatible',
      });
    }
  });

  it('prefers an explicit provider option over the baseURL', () => {
    expect(
      fromOpenAICompatible(openAIClient('https://api.openai.com/v1'), { provider: 'my_gateway' })
        .adapter,
    ).toEqual({ name: 'openai-compatible', provider: 'my_gateway' });
    expect(
      fromOpenAICompatible(openAIClient('https://api.openai.com/v1'), { provider: ' ' }).adapter,
    ).toEqual({ name: 'openai-compatible', provider: 'openai' });
  });

  it('reports the provider a fetch config names, and none otherwise', () => {
    const base = { url: 'https://example.test', mapRequest: () => ({}), mapResponse: () => ({}) };

    expect(fromFetch({ ...base, provider: 'cohere' }).adapter).toEqual({
      name: 'fetch',
      provider: 'cohere',
    });
    expect(fromFetch(base).adapter).toEqual({ name: 'fetch' });
    expect(fromFetch({ ...base, provider: '' }).adapter).toEqual({ name: 'fetch' });
  });
});
