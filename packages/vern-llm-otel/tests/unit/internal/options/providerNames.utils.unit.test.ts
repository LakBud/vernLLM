import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import {
  inferProviderName,
  UNKNOWN_PROVIDER,
} from '../../../../src/internal/options/providerNames.utils.js';

describe('providerName', () => {
  it('maps configured labels', () => {
    const { providerName } = normalizeOptions({
      providerNames: { primary: 'openai', 'fallback[0]': 'anthropic' },
    });

    expect(providerName('primary', 'whatever')).toBe('openai');
    expect(providerName('fallback[0]', 'whatever')).toBe('anthropic');
  });

  it('prefers the mapping over what the model suggests', () => {
    const { providerName } = normalizeOptions({ providerNames: { primary: 'azure.ai.openai' } });

    expect(providerName('primary', 'gpt-4o')).toBe('azure.ai.openai');
  });

  it('infers from the model for anything unmapped, never using the label', () => {
    const { providerName } = normalizeOptions({ providerNames: { primary: 'openai' } });

    expect(providerName('fallback[1]', 'claude-sonnet-4-5')).toBe('anthropic');
    expect(providerName('fallback[1]', 'my-local-model')).toBe(UNKNOWN_PROVIDER);
    expect(providerName('', '')).toBe(UNKNOWN_PROVIDER);
  });

  it('never resolves object prototype keys', () => {
    const { providerName, targetName } = normalizeOptions({});

    for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(providerName(label, '')).toBe(UNKNOWN_PROVIDER);
      expect(targetName(label)).toBe(label);
    }
  });

  it('is unaffected by later mutation of the caller object', () => {
    const names: Record<string, string> = { primary: 'openai' };
    const { providerName, targetName } = normalizeOptions({ providerNames: names });

    names.primary = 'changed';
    names['fallback[0]'] = 'added';

    expect(providerName('primary', '')).toBe('openai');
    expect(targetName('fallback[0]')).toBe('fallback[0]');
  });

  it('accepts any non empty string, not only well known values', () => {
    expect(
      normalizeOptions({ providerNames: { primary: 'my.gateway' } }).providerName('primary', ''),
    ).toBe('my.gateway');
  });
});

describe('inferProviderName', () => {
  it.each([
    ['gpt-4o-mini', 'openai'],
    ['o3-mini', 'openai'],
    ['claude-opus-4-1', 'anthropic'],
    ['gemini-2.5-pro', 'gcp.gemini'],
    ['models/gemini-2.0-flash', 'gcp.gemini'],
    ['mistral-large-latest', 'mistral_ai'],
    ['grok-4', 'x_ai'],
    ['deepseek-chat', 'deepseek'],
    ['command-r-plus', 'cohere'],
    ['anthropic.claude-3-5-sonnet-20240620-v1:0', 'aws.bedrock'],
    ['us.anthropic.claude-sonnet-4-20250514-v1:0', 'aws.bedrock'],
    ['meta.llama3-70b-instruct-v1:0', 'aws.bedrock'],
  ])('%s is %s', (model, expected) => {
    expect(inferProviderName(model)).toBe(expected);
  });

  it('gives up on an unknown model', () => {
    expect(inferProviderName('llama3:8b')).toBeUndefined();
  });
});
