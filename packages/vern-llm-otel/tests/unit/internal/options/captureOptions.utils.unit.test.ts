import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_LENGTH } from '../../../../src/internal/options/captureOptions.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

// Deliberately wrong values, so the runtime checks are exercised and not just the types.
const bad = (value: unknown) => value as never;

describe('captureContent.maxLength', () => {
  it.each([0, -1, -Infinity, Number.NaN, 1.5, 0.1])('rejects %s', (maxLength) => {
    expect(() => normalizeOptions({ captureContent: { maxLength } })).toThrow(/maxLength/);
  });

  it.each(['10', null, {}, true])('rejects the non number %j', (maxLength) => {
    expect(() => normalizeOptions({ captureContent: { maxLength: bad(maxLength) } })).toThrow(
      /maxLength/,
    );
  });

  it.each([1, 2, 8192, 1_000_000, Number.POSITIVE_INFINITY])('accepts %s', (maxLength) => {
    expect(normalizeOptions({ captureContent: { maxLength } }).capture?.maxLength).toBe(maxLength);
  });

  it('defaults to 8192', () => {
    expect(DEFAULT_MAX_LENGTH).toBe(8192);
    expect(normalizeOptions({ captureContent: true }).capture?.maxLength).toBe(8192);
  });
});

describe('captureContent resolution', () => {
  it('is off for undefined and false', () => {
    expect(normalizeOptions({}).capture).toBeUndefined();
    expect(normalizeOptions({ captureContent: false }).capture).toBeUndefined();
  });

  it('true resolves to the documented group defaults with no when', () => {
    expect(normalizeOptions({ captureContent: true }).capture).toEqual({
      input: true,
      output: true,
      systemInstructions: true,
      toolDefinitions: false,
      maxLength: 8192,
      redact: undefined,
      when: undefined,
      anyGroup: true,
    });
  });

  it('an empty object resolves like true', () => {
    expect(normalizeOptions({ captureContent: {} }).capture).toEqual(
      normalizeOptions({ captureContent: true }).capture,
    );
  });

  it('keeps explicit groups, redact, and when', () => {
    const redact = (text: string) => text;
    const when = () => true;

    const capture = normalizeOptions({
      captureContent: { input: false, toolDefinitions: true, redact, when },
    }).capture;

    expect(capture).toMatchObject({
      input: false,
      output: true,
      systemInstructions: true,
      toolDefinitions: true,
      redact,
      when,
      anyGroup: true,
    });
  });

  it('reports no enabled group when all four are off', () => {
    const capture = normalizeOptions({
      captureContent: { input: false, output: false, systemInstructions: false },
    }).capture;

    expect(capture?.anyGroup).toBe(false);
  });
});
