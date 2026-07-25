import { describe, it, expect } from 'vitest';

import {
  fromCerebras,
  fromDeepInfra,
  fromDeepSeek,
  fromFireworks,
  fromGroq,
  fromHyperbolic,
  fromLMStudio,
  fromMistral,
  fromMoonshot,
  fromNovita,
  fromOllama,
  fromOpenAICompatible,
  fromOpenRouter,
  fromPerplexity,
  fromTogether,
  fromVLLM,
  fromZhipu,
} from '../../../src/adapters/index.js';

describe('fromOpenAICompatible and its aliases', () => {
  it('returns the same client instance untouched (pure passthrough)', () => {
    const fakeClient = { chat: { completions: { create: async () => ({}) } } };
    expect(fromOpenAICompatible(fakeClient)).toBe(fakeClient);
  });

  it.each([
    ['fromGroq', fromGroq],
    ['fromMistral', fromMistral],
    ['fromDeepSeek', fromDeepSeek],
    ['fromCerebras', fromCerebras],
    ['fromTogether', fromTogether],
    ['fromFireworks', fromFireworks],
    ['fromOllama', fromOllama],
    ['fromOpenRouter', fromOpenRouter],
    ['fromPerplexity', fromPerplexity],
    ['fromDeepInfra', fromDeepInfra],
    ['fromNovita', fromNovita],
    ['fromHyperbolic', fromHyperbolic],
    ['fromMoonshot', fromMoonshot],
    ['fromZhipu', fromZhipu],
    ['fromLMStudio', fromLMStudio],
    ['fromVLLM', fromVLLM],
  ])('%s is an alias for fromOpenAICompatible', (_name, fn) => {
    expect(fn).toBe(fromOpenAICompatible);
  });
});
