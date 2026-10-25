import { describe, expect, it } from 'vitest';

import { restoreOnly } from '../../../../src/internal/output/restoreOnly.utils.js';
import { createTokenMap, tokenFor } from '../../../../src/internal/tokens/tokens.js';
import { key } from './gateHelpers.js';

describe('restoreOnly', () => {
  const tokens = createTokenMap();
  const token = tokenFor(tokens, key, 'email', 'jane@acme.com');

  it('puts values back, in the text and in nested strings, and leaves reasoning alone', () => {
    const thinking = [{ type: 'thinking', thinking: token, signature: 's' }];
    const out = restoreOnly(
      { type: 'content', content: { to: token }, thinking },
      tokens,
      undefined,
    );
    expect(out).toEqual({ type: 'content', content: { to: 'jane@acme.com' }, thinking });
  });

  it('returns the same value when there is nothing to restore', () => {
    const value = { type: 'content', content: 'plain' };
    expect(restoreOnly(value, tokens, undefined)).toBe(value);
  });
});
