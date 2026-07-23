import { describe, it, expect } from 'vitest';

import {
  fromCerebras,
  fromDeepSeek,
  fromFireworks,
  fromGroq,
  fromMistral,
  fromOllama,
  fromOpenAICompatible,
  fromTogether,
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
  ])('%s is an alias for fromOpenAICompatible', (_name, fn) => {
    expect(fn).toBe(fromOpenAICompatible);
  });
});
