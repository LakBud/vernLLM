import { describe, expect, it } from 'vitest';

import { middlewareContextNames } from '../../../../src/internal/resolveMiddlewareOrder.js';
import {
  CUSTOM_ADAPTER,
  resolveAdapterInfo,
} from '../../../../src/internal/utils/adapterInfo.utils.js';

import type { LLMClient, VernLLMMiddleware } from '../../../../src/types/index.js';

function clientWith(adapter: unknown): LLMClient {
  return {
    adapter: adapter as LLMClient['adapter'],
    chat: { completions: { create: async () => ({}) } },
  };
}

describe('resolveAdapterInfo', () => {
  it('falls back to custom when the client sets no adapter', () => {
    expect(resolveAdapterInfo(clientWith(undefined))).toBe(CUSTOM_ADAPTER);
  });

  it('falls back to custom for a blank or non string name', () => {
    expect(resolveAdapterInfo(clientWith({ name: '  ' }))).toBe(CUSTOM_ADAPTER);
    expect(resolveAdapterInfo(clientWith({ name: 42 }))).toBe(CUSTOM_ADAPTER);
  });

  it('copies and freezes the info, so the client object is never shared', () => {
    const adapter = { name: 'anthropic', provider: 'anthropic' };
    const resolved = resolveAdapterInfo(clientWith(adapter));

    expect(resolved).toEqual(adapter);
    expect(resolved).not.toBe(adapter);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('drops a blank provider instead of reporting it', () => {
    expect(resolveAdapterInfo(clientWith({ name: 'fetch', provider: '' }))).toEqual({
      name: 'fetch',
    });
  });
});

describe('middlewareContextNames', () => {
  it('returns the same lists for the same array, so contexts share one frozen copy', () => {
    const ordered: VernLLMMiddleware[] = [{ name: 'a', transform: () => ({}) }, { name: 'b' }];

    const first = middlewareContextNames(ordered);

    expect(middlewareContextNames(ordered)).toBe(first);
    expect(first).toEqual({
      registeredMiddlewareNames: ['a', 'b'],
      transformMiddlewareNames: ['a'],
    });
  });
});
