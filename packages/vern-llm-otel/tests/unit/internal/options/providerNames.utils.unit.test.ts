import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

describe('providerName', () => {
  it('maps configured labels', () => {
    const { providerName } = normalizeOptions({
      providerNames: { primary: 'openai', 'fallback[0]': 'anthropic' },
    });

    expect(providerName('primary')).toBe('openai');
    expect(providerName('fallback[0]')).toBe('anthropic');
  });

  it('falls back to the raw label for anything unmapped', () => {
    const { providerName } = normalizeOptions({ providerNames: { primary: 'openai' } });

    expect(providerName('fallback[1]')).toBe('fallback[1]');
    expect(providerName('')).toBe('');
  });

  it('never resolves object prototype keys', () => {
    const { providerName } = normalizeOptions({});

    for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(providerName(label)).toBe(label);
    }
  });

  it('is unaffected by later mutation of the caller object', () => {
    const names: Record<string, string> = { primary: 'openai' };
    const { providerName } = normalizeOptions({ providerNames: names });

    names.primary = 'changed';
    names['fallback[0]'] = 'added';

    expect(providerName('primary')).toBe('openai');
    expect(providerName('fallback[0]')).toBe('fallback[0]');
  });

  it('accepts any non empty string, not only well known values', () => {
    expect(
      normalizeOptions({ providerNames: { primary: 'my.gateway' } }).providerName('primary'),
    ).toBe('my.gateway');
  });
});
