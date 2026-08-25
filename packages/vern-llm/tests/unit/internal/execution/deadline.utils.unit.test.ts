import { describe, it, expect } from 'vitest';

import {
  DEADLINE_REASON,
  setupDeadline,
  stampDeadlineCode,
} from '../../../../src/internal/execution/utils/deadline.utils.js';
import { LLMError } from '../../../../src/types/errors.js';

describe('setupDeadline', () => {
  it('passes the caller signal through unchanged, with no timer, when deadlineMs is omitted', () => {
    const controller = new AbortController();

    const { signal, timer } = setupDeadline(undefined, controller.signal);

    expect(signal).toBe(controller.signal);
    expect(timer).toBeUndefined();
  });

  it('passes undefined through when both deadlineMs and the caller signal are omitted', () => {
    const { signal, timer } = setupDeadline(undefined, undefined);

    expect(signal).toBeUndefined();
    expect(timer).toBeUndefined();
  });

  it('returns a fresh signal and a timer when deadlineMs is set with no caller signal', () => {
    const { signal, timer } = setupDeadline(1000, undefined);

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(timer).toBeDefined();

    clearTimeout(timer);
  });

  it('combines deadlineMs with a caller signal into one signal that aborts if either fires', () => {
    const controller = new AbortController();

    const { signal, timer } = setupDeadline(1000, controller.signal);

    expect(signal?.aborted).toBe(false);
    controller.abort('caller reason');
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe('caller reason');

    clearTimeout(timer);
  });

  it('aborts the returned signal with DEADLINE_REASON once deadlineMs elapses', async () => {
    const { signal } = setupDeadline(1, undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(DEADLINE_REASON);
  });
});

describe('stampDeadlineCode', () => {
  it('stamps code: deadline_exceeded on an aborted, code-less error when the signal reason is DEADLINE_REASON', () => {
    const error = new LLMError('LLM request aborted', 'aborted');
    const controller = new AbortController();
    controller.abort(DEADLINE_REASON);

    const result = stampDeadlineCode(error, controller.signal);

    expect(result).toBe(error);
    expect((result as LLMError).code).toBe('deadline_exceeded');
  });

  it('leaves code undefined when the signal reason is not DEADLINE_REASON (a caller-supplied signal instead)', () => {
    const error = new LLMError('LLM request aborted', 'aborted');
    const controller = new AbortController();
    controller.abort();

    stampDeadlineCode(error, controller.signal);

    expect(error.code).toBeUndefined();
  });

  it('leaves code undefined when no signal is passed at all', () => {
    const error = new LLMError('LLM request aborted', 'aborted');

    stampDeadlineCode(error, undefined);

    expect(error.code).toBeUndefined();
  });

  it('never overwrites a code the error already carries', () => {
    const error = new LLMError('LLM request aborted', 'aborted', { code: 'idle_timeout' });
    const controller = new AbortController();
    controller.abort(DEADLINE_REASON);

    stampDeadlineCode(error, controller.signal);

    expect(error.code).toBe('idle_timeout');
  });

  it('does nothing for a non-aborted LLMError even if the signal reason matches', () => {
    const error = new LLMError('server error', 'api', { status: 500 });
    const controller = new AbortController();
    controller.abort(DEADLINE_REASON);

    stampDeadlineCode(error, controller.signal);

    expect(error.code).toBeUndefined();
  });

  it('passes through a non-LLMError value unchanged', () => {
    const error = new Error('plain error');
    const controller = new AbortController();
    controller.abort(DEADLINE_REASON);

    const result = stampDeadlineCode(error, controller.signal);

    expect(result).toBe(error);
  });
});
