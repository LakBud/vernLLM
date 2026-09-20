import { createMiddlewareRef, requireRef, type PreDispatchContext } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { otelMiddleware, otelMiddlewareRef } from '../../src/otelMiddleware.js';

describe('otelMiddleware entry', () => {
  it('claims the outermost position with the exported ref and the three hooks', () => {
    const entry = otelMiddleware();

    expect(entry.name).toBe('otel');
    expect(entry.ref).toBe(otelMiddlewareRef);
    expect(entry.position).toBe('outermost');
    expect(entry.priority).toBe(-1000);
    expect(entry.runsAfter).toEqual([]);
    expect(typeof entry.wrap).toBe('function');
    expect(typeof entry.transform).toBe('function');
    expect(typeof entry.onEvent).toBe('function');
  });

  it('is static: it has no enabled, which would make event delivery asynchronous', () => {
    const entry = otelMiddleware({ captureContent: { when: () => true } });

    expect('enabled' in entry).toBe(false);
    expect(entry.enabled).toBeUndefined();
  });

  it('passes name, priority, and runsAfter through', () => {
    const redaction = createMiddlewareRef('redaction');
    const required = requireRef(createMiddlewareRef('policy'));

    const entry = otelMiddleware({
      name: 'telemetry',
      priority: 7,
      runsAfter: [redaction, required],
    });

    expect(entry.name).toBe('telemetry');
    expect(entry.priority).toBe(7);
    expect(entry.runsAfter).toEqual([redaction, required]);
  });

  it('defaults capture to run after other transforms, with or without runsAfter', () => {
    const redaction = createMiddlewareRef('redaction');

    expect(otelMiddleware({ captureContent: true }).priority).toBe(1000);
    expect(otelMiddleware({ captureContent: true, runsAfter: [redaction] }).priority).toBe(1000);
    expect(otelMiddleware({ captureContent: true }).position).toBe('outermost');
  });

  it('rejects bad options at construction with a plain Error', () => {
    expect(() => otelMiddleware({ captureContent: { maxLength: 0 } })).toThrow(
      /otelMiddleware: captureContent\.maxLength/,
    );
    expect(() => otelMiddleware({ providerNames: { primary: '' } })).toThrow(/providerNames/);
  });

  it('builds without an SDK registered and without touching any global', () => {
    expect(() => otelMiddleware()).not.toThrow();
  });

  it('does not change a call if storing the tracker throws', async () => {
    const entry = otelMiddleware();
    const ctx = {
      state: {
        set: () => {
          throw new Error('state broke');
        },
        get: () => undefined,
      },
    } as unknown as PreDispatchContext;

    await expect(entry.wrap!({} as never, async () => ({ value: 'ok' }), ctx)).resolves.toEqual({
      value: 'ok',
    });
  });

  it('gives every instance its own hooks', () => {
    const a = otelMiddleware();
    const b = otelMiddleware();

    expect(a).not.toBe(b);
    expect(a.wrap).not.toBe(b.wrap);
  });
});
