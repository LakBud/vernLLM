import { tokenizeKnown } from '../tokens/tokens.js';

import type { CallView } from '../../types/index.js';
import type { CallState } from './state.js';
import type { CallMeta } from 'vern-llm';

/**
 * What a check with `callView: true` is given next to the answer: the request's text, with every value
 * that was replaced shown as its token, as the answer is. `undefined` when no output check wants
 * it, so a guard without one does no work. `meta` is left out when there is none.
 */
export function callViewOf(state: CallState, meta: CallMeta | undefined): CallView | undefined {
  const wanted = state.compiled.checks.some(
    (check) => check.callView && check.sources.has('output'),
  );
  if (!wanted) return undefined;

  return {
    input: state.inputText.map(({ source, text }) => ({
      source,
      text: tokenizeKnown(text, state.tokens),
    })),
    ...(meta !== undefined && { meta }),
  };
}
