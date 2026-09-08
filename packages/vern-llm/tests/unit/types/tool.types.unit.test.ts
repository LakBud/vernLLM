import { describe, it, expect } from 'vitest';

import {
  isToolCallResult,
  type ContentResult,
  type ToolCallResult,
} from '../../../src/types/tools.js';

describe('isToolCallResult()', () => {
  it('returns true for a tool_calls result', () => {
    const result: ToolCallResult = {
      type: 'tool_calls',
      toolCalls: [{ id: '1', name: 'get_weather', arguments: { city: 'NYC' } }],
    };

    expect(isToolCallResult(result)).toBe(true);
  });

  it('narrows toolCalls when true', () => {
    const result: ToolCallResult = {
      type: 'tool_calls',
      toolCalls: [{ id: '1', name: 'get_weather', arguments: { city: 'NYC' } }],
    };

    if (isToolCallResult(result)) {
      expect(result.toolCalls[0]?.name).toBe('get_weather');
    } else {
      throw new Error('expected isToolCallResult to return true');
    }
  });

  it('returns false for a content result', () => {
    const result: ContentResult<string> = { type: 'content', content: 'hi' };

    expect(isToolCallResult(result)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isToolCallResult('hi')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isToolCallResult(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isToolCallResult(undefined)).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isToolCallResult(42)).toBe(false);
  });

  it('returns false for an object with type: tool_calls but a non-array toolCalls', () => {
    expect(isToolCallResult({ type: 'tool_calls', toolCalls: 'nope' })).toBe(false);
  });

  it('returns false for an object missing toolCalls entirely', () => {
    expect(isToolCallResult({ type: 'tool_calls' })).toBe(false);
  });

  it('returns false for an object with the wrong type value', () => {
    expect(isToolCallResult({ type: 'content', toolCalls: [] })).toBe(false);
  });

  it('accepts an empty toolCalls array as a valid tool_calls result', () => {
    expect(isToolCallResult({ type: 'tool_calls', toolCalls: [] })).toBe(true);
  });

  it('accepts an explicit Tools type argument without changing runtime behavior', () => {
    const result: ToolCallResult = {
      type: 'tool_calls',
      toolCalls: [{ id: '1', name: 'get_weather', arguments: { city: 'NYC' } }],
    };

    expect(isToolCallResult<never>(result)).toBe(true);
  });
});
