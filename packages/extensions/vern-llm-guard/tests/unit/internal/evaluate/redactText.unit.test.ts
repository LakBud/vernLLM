import { describe, expect, it } from 'vitest';

import { redactText } from '../../../../src/internal/evaluate/redactText.js';
import { compile } from '../../../../src/internal/options/compile.utils.js';

import type { Check, Detector } from '../../../../src/index.js';

const word =
  (needle: string, extra: object = {}): Detector =>
  (segments) => {
    const at = segments[0]!.text.indexOf(needle);
    return at === -1 ? [] : [{ segment: 0, start: at, end: at + needle.length, ...extra }];
  };

const run = (text: string, checks: Check[], onError: 'open' | 'closed' = 'closed') =>
  redactText(compile({ version: 'v', checks, onError }), text);

describe('redactText', () => {
  it('leaves an empty text and a clean text alone', () => {
    expect(run('', [{ id: 'a', detect: word('x'), action: 'redact' }])).toBe('');
    expect(run('fine', [{ id: 'a', detect: word('x'), action: 'redact' }])).toBe('fine');
  });

  it('masks what redact and block checks find, by label, and ignores audit and label checks', () => {
    const out = run('a hunter2 b secret c', [
      { id: 'a', detect: word('hunter2', { label: 'pw' }), action: 'redact' },
      { id: 'b', detect: word('secret'), action: 'block' },
      { id: 'c', detect: word('a'), action: 'redact', mode: 'audit' },
      { id: 'd', detect: word('b'), action: 'label' },
    ]);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('secret');
    expect(out.startsWith('a ')).toBe(true);
    expect(out).toContain(' b ');
  });

  it('skips a check that answers with a promise', () => {
    const slow: Detector = () => Promise.resolve([{ segment: 0, start: 0, end: 1 }]);
    expect(run('abc', [{ id: 'a', detect: slow, action: 'block' }])).toBe('abc');
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('x');
      },
    ],
    ['returns something that is not a list', () => 'nope' as never],
  ] as const)(
    'masks everything when a check that fails closed %s, and skips it when open',
    (_n, detect) => {
      const check: Check = { id: 'a', detect: detect as Detector, action: 'block' };
      expect(run('abc', [check])).not.toContain('abc');
      expect(run('abc', [{ ...check, onError: 'open' }])).toBe('abc');
    },
  );

  it.each([
    ['no offsets', { segment: 0 }],
    ['a fractional offset', { segment: 0, start: 0.5, end: 2 }],
    ['an offset past the text', { segment: 0, start: 0, end: 99 }],
    ['an empty range', { segment: 0, start: 1, end: 1 }],
  ])('masks everything for a finding it cannot locate: %s', (_n, finding) => {
    expect(run('abc', [{ id: 'a', detect: () => [finding], action: 'block' }])).not.toContain(
      'abc',
    );
  });

  it('ignores a finding for another segment, or one that is not an object', () => {
    const detect = (() => [{ segment: 3, start: 0, end: 1 }, null]) as unknown as Detector;
    expect(run('abc', [{ id: 'a', detect, action: 'block' }])).toBe('abc');
  });
});
