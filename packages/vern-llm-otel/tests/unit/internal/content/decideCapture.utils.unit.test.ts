import { describe, expect, it, vi } from 'vitest';

import { decideCapture } from '../../../../src/internal/content/decideCapture.utils.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { CaptureContentOptions } from '../../../../src/types/index.js';
import type { Span } from '@opentelemetry/api';
import type { PreDispatchContext, WireCallRequest, WireMessage } from 'vern-llm';

function setup(options: CaptureContentOptions = {}) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const capture = normalizeOptions({ captureContent: options }).capture!;
  return { capture, logger, guard: createGuard(logger) };
}

const request = (
  messages: WireMessage[],
  extra: Partial<WireCallRequest> = {},
): WireCallRequest => ({ model: 'gpt-4o', max_tokens: 100, messages, ...extra });

describe('decideCapture', () => {
  const ctx = { requestId: 'r' } as PreDispatchContext;
  const req = request([{ role: 'user', content: 'hi' }]);
  const spanOf = (recording: boolean) => ({ isRecording: () => recording }) as unknown as Span;

  it('captures when nothing gates it', () => {
    const { capture, guard } = setup();
    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(true);
  });

  it('does not run user code when no group is enabled', () => {
    const when = vi.fn(() => true);
    const { capture, guard } = setup({
      input: false,
      output: false,
      systemInstructions: false,
      when,
    });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    expect(when).not.toHaveBeenCalled();
  });

  it('does not run user code when the span is not recording', () => {
    const when = vi.fn(() => true);
    const { capture, guard } = setup({ when });

    expect(decideCapture(capture, ctx, req, spanOf(false), guard)).toBe(false);
    expect(when).not.toHaveBeenCalled();
  });

  it('gives the callback the context and the request it was asked about', () => {
    const when = vi.fn((_ctx: PreDispatchContext, _request: Readonly<WireCallRequest>) => true);
    const { capture, guard } = setup({ when });

    decideCapture(capture, ctx, req, spanOf(true), guard);

    expect(when).toHaveBeenCalledTimes(1);
    expect(when.mock.calls[0]?.[0]).toBe(ctx);
    expect(when.mock.calls[0]?.[1]).toBe(req);
  });

  it('captures only for exactly true', () => {
    expect(
      decideCapture(setup({ when: () => true }).capture, ctx, req, spanOf(true), setup().guard),
    ).toBe(true);
    expect(
      decideCapture(setup({ when: () => false }).capture, ctx, req, spanOf(true), setup().guard),
    ).toBe(false);
  });

  it.each(['yes', 'true', 1, {}, [], null, undefined])('treats %j as no', (value) => {
    const { capture, guard, logger } = setup({ when: () => value as never });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails closed and logs once when the callback throws', () => {
    const { capture, guard, logger } = setup({
      when: () => {
        throw new Error('policy service down');
      },
    });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: captureContent.when failed',
      expect.objectContaining({ message: 'policy service down' }),
    );
  });

  it('refuses and logs once when the callback returns a promise, even a resolved true', async () => {
    const { capture, guard, logger } = setup({ when: (() => Promise.resolve(true)) as never });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: captureContent.when failed',
      expect.objectContaining({ message: expect.stringContaining('promise') }),
    );
  });

  it('does not leave an unhandled rejection behind when the promise rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const { capture, guard } = setup({
        when: (() => Promise.reject(new Error('async policy failure'))) as never,
      });

      expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('refuses a thenable that throws when observed', () => {
    const hostile = {
      get then(): never {
        throw new Error('hostile getter');
      },
    };
    const { capture, guard } = setup({ when: (() => hostile) as never });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
  });
});
