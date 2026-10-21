import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { DeferredSpan } from '../../../../src/internal/tracker/deferredSpan.js';

function fakeSpan() {
  const span = {
    spanContext: vi.fn(() => ({ traceId: 't', spanId: 's', traceFlags: 1 })),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
  };
  return span as typeof span & Span;
}

describe('DeferredSpan', () => {
  it('starts nothing until it is used', () => {
    const start = vi.fn(fakeSpan);
    const deferred = new DeferredSpan(start);

    expect(deferred.started).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts once, on the first use of any kind', () => {
    const real = fakeSpan();
    const start = vi.fn(() => real);
    const deferred = new DeferredSpan(start);

    expect(deferred.spanContext().spanId).toBe('s');
    expect(deferred.isRecording()).toBe(true);

    expect(start).toHaveBeenCalledOnce();
    expect(deferred.started).toBe(true);
  });

  it('forwards every call to the real span, and chains on itself', () => {
    const real = fakeSpan();
    const deferred = new DeferredSpan(() => real);
    const link = { context: real.spanContext() };
    const error = new Error('x');

    expect(deferred.setAttribute('a', 1)).toBe(deferred);
    expect(deferred.setAttributes({ b: 2 })).toBe(deferred);
    expect(deferred.addEvent('e', { c: 3 }, 5)).toBe(deferred);
    expect(deferred.addLink(link)).toBe(deferred);
    expect(deferred.addLinks([link])).toBe(deferred);
    expect(deferred.setStatus({ code: SpanStatusCode.OK })).toBe(deferred);
    expect(deferred.updateName('renamed')).toBe(deferred);
    deferred.recordException(error, 7);
    deferred.end(9);

    expect(real.setAttribute).toHaveBeenCalledWith('a', 1);
    expect(real.setAttributes).toHaveBeenCalledWith({ b: 2 });
    expect(real.addEvent).toHaveBeenCalledWith('e', { c: 3 }, 5);
    expect(real.addLink).toHaveBeenCalledWith(link);
    expect(real.addLinks).toHaveBeenCalledWith([link]);
    expect(real.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(real.updateName).toHaveBeenCalledWith('renamed');
    expect(real.recordException).toHaveBeenCalledWith(error, 7);
    expect(real.end).toHaveBeenCalledWith(9);
  });
});
