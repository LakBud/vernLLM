import { describe, it, expect } from 'vitest';

import { isStreamResult, type StreamCallResult } from '../../../src/types/stream.js';

/** Minimal empty async iterable, enough to satisfy `chunks`'s shape for these tests. */
async function* emptyChunks(): AsyncIterable<never> {}

describe('isStreamResult()', () => {
  it('returns true for a real StreamCallResult', () => {
    const result: StreamCallResult<string> = {
      chunks: emptyChunks(),
      finalResult: Promise.resolve('hi'),
    };

    expect(isStreamResult(result)).toBe(true);
  });

  it('narrows to chunks/finalResult when true', async () => {
    const result: StreamCallResult<string> = {
      chunks: emptyChunks(),
      finalResult: Promise.resolve('hi'),
    };

    if (isStreamResult(result)) {
      await expect(result.finalResult).resolves.toBe('hi');
    } else {
      throw new Error('expected isStreamResult to return true');
    }
  });

  it('returns false for a plain string', () => {
    expect(isStreamResult('hi')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isStreamResult(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isStreamResult(undefined)).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isStreamResult(42)).toBe(false);
  });

  it('returns false for a plain object with no chunks/finalResult', () => {
    expect(isStreamResult({ content: 'hi' })).toBe(false);
  });

  it('returns false when chunks is present but finalResult is missing', () => {
    expect(isStreamResult({ chunks: emptyChunks() })).toBe(false);
  });

  it('returns false when finalResult is not thenable', () => {
    expect(isStreamResult({ chunks: emptyChunks(), finalResult: 'not a promise' })).toBe(false);
  });

  it('returns false when finalResult is null', () => {
    expect(isStreamResult({ chunks: emptyChunks(), finalResult: null })).toBe(false);
  });

  it('returns true for a thenable that is not a real Promise instance', () => {
    const thenable = { then: () => {} };

    expect(isStreamResult({ chunks: emptyChunks(), finalResult: thenable })).toBe(true);
  });

  it('returns false when finalResult.then is not a function', () => {
    expect(isStreamResult({ chunks: emptyChunks(), finalResult: { then: 'nope' } })).toBe(false);
  });
});
