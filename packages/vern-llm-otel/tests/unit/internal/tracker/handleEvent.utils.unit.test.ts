import { context, createContextKey } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { handleEvent } from '../../../../src/internal/tracker/handleEvent.utils.js';

import type { Metrics } from '../../../../src/internal/metrics/metrics.utils.js';
import type { CallTracker } from '../../../../src/internal/tracker/callTracker.js';
import type { VernLLMEvent } from 'vern-llm';

const event = {
  kind: 'rate_limited',
  provider: 'primary',
  model: 'gpt-4o',
  waitedMs: 5,
  reason: 'tokens',
} as unknown as VernLLMEvent;

function fakeMetrics(calls: string[] = []) {
  return {
    record: vi.fn(),
    recordEvent: vi.fn(() => {
      calls.push('metrics');
    }),
  } satisfies Metrics;
}

function fakeTracker(calls: string[] = [], measurement = context.active()) {
  return {
    measurementContext: vi.fn(() => measurement),
    applyEvent: vi.fn(() => {
      calls.push('spans');
    }),
  } as unknown as CallTracker & {
    measurementContext: ReturnType<typeof vi.fn>;
    applyEvent: ReturnType<typeof vi.fn>;
  };
}

describe('handleEvent', () => {
  it('still records metrics when there is no tracker', () => {
    const metrics = fakeMetrics();

    handleEvent(event, undefined, metrics);

    expect(metrics.recordEvent).toHaveBeenCalledWith(event, undefined);
  });

  it('records metrics before touching spans', () => {
    const calls: string[] = [];
    const metrics = fakeMetrics(calls);
    const tracker = fakeTracker(calls);

    handleEvent(event, tracker, metrics);

    expect(calls).toEqual(['metrics', 'spans']);
  });

  it('records against the context the tracker asks for', () => {
    const measurement = context.active().setValue(createContextKey('attempt'), 1);
    const metrics = fakeMetrics();
    const tracker = fakeTracker([], measurement);

    handleEvent(event, tracker, metrics);

    expect(metrics.recordEvent).toHaveBeenCalledWith(event, measurement);
  });

  it('hands the same event to the tracker', () => {
    const tracker = fakeTracker();

    handleEvent(event, tracker, fakeMetrics());

    expect(tracker.applyEvent).toHaveBeenCalledExactlyOnceWith(event);
  });
});
