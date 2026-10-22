import { LLMError, type VernLLMEvent } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { applyEvent } from '../../../../src/internal/recorder/applyEvent.utils.js';

import type { CallRecorder } from '../../../../src/internal/recorder/callRecorder.js';

function spyRecorder() {
  return {
    queued: vi.fn(),
    retried: vi.fn(),
    fellBack: vi.fn(),
    noteBreaker: vi.fn(),
    noteMiddleware: vi.fn(),
    setUsage: vi.fn(),
    addCustom: vi.fn(),
  };
}

const run = (event: VernLLMEvent, keep: (name: string) => boolean = () => true) => {
  const recorder = spyRecorder();
  applyEvent(recorder as unknown as CallRecorder, event, keep);
  return recorder;
};

const error = new LLMError('x', 'api');
const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3, requestId: 'r', model: 'm' };

describe('applyEvent', () => {
  it('maps rate_limited to a queue wait', () => {
    const r = run({
      kind: 'rate_limited',
      requestId: 'r',
      provider: 'p',
      model: 'm',
      waitedMs: 42,
      reason: 'rpm',
    });
    expect(r.queued).toHaveBeenCalledWith(42);
  });

  it('maps retry to a retry with its delay and error', () => {
    const r = run({
      kind: 'retry',
      requestId: 'r',
      provider: 'p',
      model: 'm',
      attempt: 1,
      maxRetries: 2,
      delayMs: 150,
      retryAfterHonored: false,
      error,
    });
    expect(r.retried).toHaveBeenCalledWith(150, error);
  });

  it('maps fallback to leaving a target, with the core elapsed time and error', () => {
    const r = run({
      kind: 'fallback',
      requestId: 'r',
      from: 'primary',
      to: 'fallback[0]',
      fromIndex: -1,
      toIndex: 0,
      error,
      elapsedMs: 900,
    });
    expect(r.fellBack).toHaveBeenCalledWith(900, error);
  });

  it('maps circuit_state to a breaker change with only the logged fields', () => {
    const r = run({
      kind: 'circuit_state',
      provider: 'primary',
      model: 'm',
      from: 'closed',
      to: 'open',
      consecutiveFailures: 5,
    });
    expect(r.noteBreaker).toHaveBeenCalledWith({
      provider: 'primary',
      model: 'm',
      from: 'closed',
      to: 'open',
    });
  });

  it('maps a middleware event to a note, copying patched fields', () => {
    const patchedFields = ['temperature'];
    const r = run({
      kind: 'middleware',
      requestId: 'r',
      middleware: 'patcher',
      hook: 'transform',
      patchedFields,
    });

    expect(r.noteMiddleware).toHaveBeenCalledWith({
      kind: 'transform',
      name: 'patcher',
      patchedFields: ['temperature'],
    });
    expect(r.noteMiddleware.mock.calls[0]![0].patchedFields).not.toBe(patchedFields);
  });

  it('leaves patchedFields off when the event has none', () => {
    const r = run({
      kind: 'middleware',
      requestId: 'r',
      middleware: 'guard',
      hook: 'wrap_short_circuit',
    });
    expect(r.noteMiddleware).toHaveBeenCalledWith({ kind: 'wrap_short_circuit', name: 'guard' });
  });

  it('maps usage and usage_failure, telling them apart', () => {
    expect(run({ kind: 'usage', requestId: 'r', usage }).setUsage).toHaveBeenCalledWith(
      usage,
      false,
    );
    expect(
      run({ kind: 'usage_failure', requestId: 'r', usage, error }).setUsage,
    ).toHaveBeenCalledWith(usage, true);
  });

  it('keeps a custom event only when its name is wanted', () => {
    const event: VernLLMEvent = {
      kind: 'custom',
      requestId: 'r',
      name: 'router.decision',
      source: 's',
      data: { a: 1 },
    };

    expect(run(event, (name) => name === 'router.decision').addCustom).toHaveBeenCalledWith(
      'router.decision',
      { a: 1 },
    );
    expect(run(event, () => false).addCustom).not.toHaveBeenCalled();
  });
});
