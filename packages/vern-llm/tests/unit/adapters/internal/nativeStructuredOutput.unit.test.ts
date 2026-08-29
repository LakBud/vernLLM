import { describe, it, expect, vi } from 'vitest';

import { supportsNativeStructuredOutput } from '../../../../src/adapters/internal/nativeStructuredOutput.js';

describe('supportsNativeStructuredOutput', () => {
  it('returns false when no override is given', () => {
    expect(supportsNativeStructuredOutput('claude-x')).toBe(false);
  });

  it('returns false for an undefined override passed explicitly', () => {
    expect(supportsNativeStructuredOutput('claude-x', undefined)).toBe(false);
  });

  it('returns true when an array override includes the model', () => {
    expect(supportsNativeStructuredOutput('claude-x', ['claude-x', 'claude-y'])).toBe(true);
  });

  it('returns false when an array override does not include the model', () => {
    expect(supportsNativeStructuredOutput('claude-z', ['claude-x', 'claude-y'])).toBe(false);
  });

  it('returns false for an empty array override', () => {
    expect(supportsNativeStructuredOutput('claude-x', [])).toBe(false);
  });

  it('is an exact-match check for the array form, not a substring match', () => {
    expect(supportsNativeStructuredOutput('claude-x-2', ['claude-x'])).toBe(false);
  });

  it('calls a predicate override with the model and returns its result when true', () => {
    const predicate = vi.fn((model: string) => model.startsWith('claude-'));

    expect(supportsNativeStructuredOutput('claude-x', predicate)).toBe(true);
    expect(predicate).toHaveBeenCalledWith('claude-x');
  });

  it('calls a predicate override with the model and returns its result when false', () => {
    const predicate = vi.fn((model: string) => model.startsWith('claude-'));

    expect(supportsNativeStructuredOutput('gpt-x', predicate)).toBe(false);
    expect(predicate).toHaveBeenCalledWith('gpt-x');
  });

  it('does not call a predicate override more than once per resolution', () => {
    const predicate = vi.fn(() => true);

    supportsNativeStructuredOutput('any-model', predicate);

    expect(predicate).toHaveBeenCalledTimes(1);
  });
});
