import { describe, expect, it, vi } from 'vitest';

import { createTextPiece } from '../../../../src/internal/content/textPiece.utils.js';
import { TRUNCATION_MARKER } from '../../../../src/internal/content/truncate.utils.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { CaptureContentOptions } from '../../../../src/types/index.js';

function setup(options: CaptureContentOptions = {}) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const capture = normalizeOptions({ captureContent: options }).capture!;
  return { logger, piece: createTextPiece(capture, createGuard(logger)) };
}

describe('createTextPiece', () => {
  it('passes text through when nothing limits or redacts it', () => {
    const { piece } = setup();
    expect(piece('hello')).toBe('hello');
  });

  it('spends one shared budget across every piece it produces', () => {
    const { piece } = setup({ maxLength: 8 });

    expect(piece('abcde')).toBe('abcde');
    // Three characters are left, so the next piece is cut to fit.
    expect(piece('fghijk')).toBe(`fgh${TRUNCATION_MARKER}`);
    // Nothing is left after that, and later pieces are reduced to the marker alone.
    expect(piece('lmn')).toBe(TRUNCATION_MARKER);
  });

  it('never truncates with an infinite budget', () => {
    const { piece } = setup({ maxLength: Number.POSITIVE_INFINITY });
    const long = 'x'.repeat(100_000);
    expect(piece(long)).toBe(long);
  });

  it('gives each piece function its own budget', () => {
    const first = setup({ maxLength: 3 });
    const second = setup({ maxLength: 3 });

    expect(first.piece('abc')).toBe('abc');
    expect(second.piece('abc')).toBe('abc');
  });

  it('redacts before spending the budget', () => {
    const { piece } = setup({ maxLength: 4, redact: (text) => text.replace('secret', 'x') });
    expect(piece('secret')).toBe('x');
  });

  it('leaves the piece out and logs when the redactor throws', () => {
    const { piece, logger } = setup({
      redact: () => {
        throw new Error('redactor broke');
      },
    });

    expect(piece('secret')).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: captureContent.redact failed',
      expect.objectContaining({ message: 'redactor broke' }),
    );
  });

  it('leaves the piece out when the redactor returns something other than a string', () => {
    const { piece } = setup({ redact: (() => 42) as unknown as (text: string) => string });
    expect(piece('secret')).toBeUndefined();
  });

  it('does not spend budget on a piece that was left out', () => {
    let calls = 0;
    const { piece } = setup({
      maxLength: 5,
      redact: (text) => {
        calls++;
        if (calls === 1) throw new Error('once');
        return text;
      },
    });

    expect(piece('secret')).toBeUndefined();
    expect(piece('abcde')).toBe('abcde');
  });
});
