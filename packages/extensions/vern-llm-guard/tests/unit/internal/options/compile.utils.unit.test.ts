import { describe, expect, it } from 'vitest';

import { compile } from '../../../../src/internal/options/compile.utils.js';

import type { Check, GuardOptions } from '../../../../src/index.js';

const detect = () => [];
const options = (overrides: Partial<GuardOptions> = {}): GuardOptions => ({
  version: 'v1',
  checks: [{ id: 'one', detect }],
  ...overrides,
});
const withCheck = (check: Partial<Check>) =>
  options({ checks: [{ id: 'one', detect, ...check } as Check] });

describe('compile', () => {
  it('fills in defaults', () => {
    const compiled = compile(options());
    const [check] = compiled.checks;

    expect(compiled).toMatchObject({ version: 'v1', memoMax: 10_000, failClosed: true });
    expect(check).toMatchObject({
      id: 'one',
      action: 'label',
      label: 'one',
      audit: false,
      timeoutMs: 2000,
      failClosed: true,
    });
    expect([...check!.sources].sort()).toEqual(['assistant', 'system', 'tool', 'user']);
  });

  it('expands input into every role, and a role into itself', () => {
    expect([...compile(withCheck({ on: 'input' })).checks[0]!.sources].sort()).toEqual([
      'assistant',
      'system',
      'tool',
      'user',
    ]);
    expect([...compile(withCheck({ on: ['user', 'tool'] })).checks[0]!.sources].sort()).toEqual([
      'tool',
      'user',
    ]);
    expect([...compile(withCheck({ on: 'system' })).checks[0]!.sources]).toEqual(['system']);
  });

  it('lets a check take the instance default for onError, or set its own', () => {
    expect(compile(options({ onError: 'open' })).checks[0]!.failClosed).toBe(false);
    expect(
      compile({ ...withCheck({ onError: 'closed' }), onError: 'open' }).checks[0]!.failClosed,
    ).toBe(true);
    expect(compile(withCheck({ onError: 'open' })).checks[0]!.failClosed).toBe(false);
  });

  it('reads audit, label, action and timeout', () => {
    const [check] = compile(
      withCheck({ mode: 'audit', label: 'pii', action: 'block', timeoutMs: 50 }),
    ).checks;
    expect(check).toMatchObject({ audit: true, label: 'pii', action: 'block', timeoutMs: 50 });
  });

  it('reads the memo size, or turns the memo off', () => {
    expect(compile(options({ memo: { max: 5 } })).memoMax).toBe(5);
    expect(compile(options({ memo: {} })).memoMax).toBe(10_000);
    expect(compile(options({ memo: false })).memoMax).toBe(0);
  });

  it('freezes what it returns, so a call can hold it while an update swaps another in', () => {
    const compiled = compile(options());
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.checks)).toBe(true);
    expect(Object.isFrozen(compiled.checks[0])).toBe(true);
  });

  describe('rejects a mistake with a message that names the field', () => {
    it.each([
      ['options', null, /options must be an object/],
      ['version', options({ version: '' }), /version must be a non empty string/],
      ['checks', options({ checks: 'x' as unknown as Check[] }), /checks must be an array/],
      ['instance onError', options({ onError: 'maybe' as 'open' }), /onError must be 'closed'/],
      ['memo', options({ memo: { max: 0 } }), /memo must be false/],
      ['memo shape', options({ memo: 5 as unknown as false }), /memo must be false/],
      ['a check', options({ checks: [null as unknown as Check] }), /checks\[0\] must be an object/],
      ['id', withCheck({ id: '' }), /checks\[0\]\.id must be a non empty string/],
      [
        'detect',
        withCheck({ detect: 'x' as unknown as Check['detect'] }),
        /\.detect must be a function/,
      ],
      [
        'action',
        withCheck({ action: 'mask' as 'block' }),
        /\.action must be 'label', 'redact', 'block'/,
      ],
      ['mode', withCheck({ mode: 'off' as 'audit' }), /\.mode must be 'enforce', 'audit'/],
      [
        'check onError',
        withCheck({ onError: 'x' as 'open' }),
        /\.onError must be 'closed', 'open'/,
      ],
      ['label', withCheck({ label: '' }), /\.label must be a non empty string/],
      ['when', withCheck({ when: true as unknown as () => boolean }), /\.when must be a function/],
      ['timeoutMs', withCheck({ timeoutMs: 0 }), /\.timeoutMs must be a positive number/],
      ['infinite timeoutMs', withCheck({ timeoutMs: Infinity }), /\.timeoutMs must be/],
      ['NaN timeoutMs', withCheck({ timeoutMs: Number.NaN }), /\.timeoutMs must be/],
      ['too long timeoutMs', withCheck({ timeoutMs: 2_147_483_648 }), /at most 2147483647/],
      ['on', withCheck({ on: 'answer' as 'user' }), /\.on must be 'input', 'user'/],
      ['on list', withCheck({ on: ['user', 'x'] as 'user'[] }), /\.on must be/],
      ['empty on', withCheck({ on: [] }), /\.on must not be empty/],
    ])('%s', (_field, bad, message) => {
      expect(() => compile(bad as GuardOptions)).toThrow(message);
      expect(() => compile(bad as GuardOptions)).toThrow(TypeError);
      expect(() => compile(bad as GuardOptions)).toThrow(/^guardMiddleware: /);
    });

    it.each([
      [
        'redactFor on a check that does not redact',
        withCheck({ redactFor: () => true }),
        /only for action 'redact'/,
      ],
      [
        'restore on a check that does not redact',
        withCheck({ restore: false }),
        /only for action 'redact'/,
      ],
      [
        'redactFor',
        withCheck({ action: 'redact', redactFor: 1 as never }),
        /\.redactFor must be a function/,
      ],
      [
        'restore',
        withCheck({ action: 'redact', restore: 'no' as never }),
        /\.restore must be true or false/,
      ],
      [
        'a short key',
        options({ key: 'short' }),
        /key must be a string or bytes of at least 32 bytes/,
      ],
      ['a key of the wrong type', options({ key: 5 as never }), /key must be a string or bytes/],
      ['mask', options({ mask: 'x' as never }), /mask must be a function/],
      ['spotlight', options({ spotlight: 1 as never }), /spotlight must be an object/],
      [
        'spotlight sources',
        options({ spotlight: { sources: ['system'] as never } }),
        /spotlight\.sources must be a list of 'tool', 'user', 'assistant'/,
      ],
      [
        'empty spotlight sources',
        options({ spotlight: { sources: [] } }),
        /spotlight\.sources must be a list/,
      ],
      ['parallel', withCheck({ parallel: 'yes' as never }), /\.parallel must be true or false/],
      [
        'parallel that redacts',
        withCheck({ parallel: true, action: 'redact' }),
        /parallel is only for input checks with action 'block'/,
      ],
      [
        'parallel that labels',
        withCheck({ parallel: true }),
        /parallel is only for input checks with action 'block'/,
      ],
      [
        'parallel on output',
        withCheck({ parallel: true, action: 'block', on: ['user', 'output'] }),
        /parallel is only for input checks/,
      ],
      ['stream', options({ stream: 1 as never }), /stream must be an object/],
      [
        'stream release',
        options({ stream: { release: 'late' as never } }),
        /stream\.release must be 'checked', 'immediate'/,
      ],
      [
        'a short holdChars',
        options({ stream: { holdChars: 8 } }),
        /holdChars must be an integer of at least 32/,
      ],
      [
        'a fractional holdChars',
        options({ stream: { holdChars: 40.5 } }),
        /holdChars must be an integer/,
      ],
      [
        'windowChars not above holdChars',
        options({ stream: { holdChars: 64, windowChars: 64 } }),
        /windowChars must be an integer larger than stream\.holdChars/,
      ],
    ])('%s', (_field, bad, message) => {
      expect(() => compile(bad as GuardOptions)).toThrow(message);
    });

    it('a repeated id', () => {
      const bad = options({
        checks: [
          { id: 'a', detect },
          { id: 'a', detect },
        ],
      });
      expect(() => compile(bad)).toThrow(/checks\[1\]\.id "a" is used twice/);
    });
  });

  describe('redact, output, key and mask', () => {
    it('reads output as a source of its own, apart from input', () => {
      const compiled = compile(withCheck({ on: ['input', 'output'] }));
      expect([...compiled.checks[0]!.sources].sort()).toEqual([
        'assistant',
        'output',
        'system',
        'tool',
        'user',
      ]);
      expect([...compile(withCheck({ on: 'output' })).checks[0]!.sources]).toEqual(['output']);
    });

    it('restores by default and reads redactFor and restore', () => {
      const redactFor = () => false;
      const plain = compile(withCheck({ action: 'redact' })).checks[0]!;
      const custom = compile(withCheck({ action: 'redact', restore: false, redactFor })).checks[0]!;

      expect(plain).toMatchObject({ restore: true, redactFor: undefined });
      expect(custom).toMatchObject({ restore: false, redactFor });
    });

    it('splits the checks that run alongside the call from the ones before it', () => {
      const none = compile(options());
      const some = compile(
        options({
          checks: [
            { id: 'first', detect },
            { id: 'later', detect, action: 'block', parallel: true },
          ],
        }),
      );

      expect(none.serial).toBeUndefined();
      expect(none.parallel).toEqual([]);
      expect([...some.serial!]).toEqual(['first']);
      expect(some.parallel.map((check) => check.id)).toEqual(['later']);
    });

    it('turns spotlight on for tool results by default, and reads the sources', () => {
      expect(compile(options()).spotlight).toBeUndefined();
      expect([...compile(options({ spotlight: {} })).spotlight!]).toEqual(['tool']);
      expect(
        [...compile(options({ spotlight: { sources: ['user', 'tool'] } })).spotlight!].sort(),
      ).toEqual(['tool', 'user']);
    });

    it('fills in the stream defaults, and keeps the window above a large holdChars', () => {
      expect(compile(options()).stream).toEqual({
        release: 'checked',
        holdChars: 128,
        windowChars: 1000,
      });
      expect(compile(options({ stream: { holdChars: 2000 } })).stream.windowChars).toBe(2001);
      expect(
        compile(options({ stream: { release: 'immediate', holdChars: 40, windowChars: 80 } }))
          .stream,
      ).toEqual({ release: 'immediate', holdChars: 40, windowChars: 80 });
    });

    it('takes a key as a string or as bytes, and masks with the uppercase label by default', () => {
      expect(compile(options({ key: 'k'.repeat(32) })).key).toHaveLength(32);
      expect(compile(options({ key: new Uint8Array(40) })).key).toHaveLength(40);
      expect(compile(options()).key).toBeUndefined();
      expect(compile(options()).mask('email')).toBe('[EMAIL]');
      expect(compile(options({ mask: (label) => `<${label}>` })).mask('email')).toBe('<email>');
    });
  });
});
