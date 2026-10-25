import { describe, expect, it } from 'vitest';

import { advance, startState, stringAt } from '../../../../src/internal/output/json.utils.js';

describe('json state', () => {
  it('follows strings, quotes and escapes', () => {
    const state = startState();
    advance(state, '{"a": "b\\"');
    expect(state).toEqual({ inString: true, escaped: false });
    advance(state, 'c\\');
    expect(state).toEqual({ inString: true, escaped: true });
    advance(state, '\\');
    expect(state.escaped).toBe(false);
    advance(state, '"');
    expect(state.inString).toBe(false);
  });

  it('says whether an index is inside a string, from a state at the start', () => {
    const text = '{"a": 12, "b": "x y"}';
    expect(stringAt(startState(), text, text.indexOf('12'))).toBe(false);
    expect(stringAt(startState(), text, text.indexOf('x y'))).toBe(true);
    expect(stringAt({ inString: true, escaped: false }, 'ab"cd', 4)).toBe(false);
  });
});
