/** Where a scan of JSON text is, so a position can be said to be inside a string or not. */
export interface JsonState {
  inString: boolean;
  escaped: boolean;
}

export const startState = (): JsonState => ({ inString: false, escaped: false });

/** Moves `state` over `text`. */
export function advance(state: JsonState, text: string): void {
  for (const char of text) {
    if (!state.inString) {
      state.inString = char === '"';
    } else if (state.escaped) {
      state.escaped = false;
    } else {
      state.escaped = char === '\\';
      if (char === '"') state.inString = false;
    }
  }
}

/** Whether `index` in `text` is inside a string, given the state at the start of `text`. */
export function stringAt(start: JsonState, text: string, index: number): boolean {
  const state = { ...start };
  advance(state, text.slice(0, index));
  return state.inString;
}
