import { describe, it, expect, vi } from 'vitest';

import {
  withReservedUsage,
  withReservedUsageForStream,
} from '../../../../src/internal/execution/utils/usage.utils';

describe('withReservedUsage', () => {
  it('runs getResult and returns its value when no reserveUsage hook is given', async () => {
    const getResult = vi.fn().mockResolvedValue('ok');
    const onRefundError = vi.fn();

    const result = await withReservedUsage({}, false, getResult, undefined, onRefundError);

    expect(result).toBe('ok');
    expect(getResult).toHaveBeenCalledOnce();
    expect(onRefundError).not.toHaveBeenCalled();
  });

  it('reserves before calling getResult and does not refund on success', async () => {
    const calls: string[] = [];
    const reserveUsage = vi.fn().mockImplementation(async () => {
      calls.push('reserve');
    });
    const refundUsage = vi.fn().mockImplementation(async () => {
      calls.push('refund');
    });
    const getResult = vi.fn().mockImplementation(async () => {
      calls.push('getResult');
      return 'done';
    });

    const result = await withReservedUsage(
      { reserveUsage, refundUsage },
      false,
      getResult,
      undefined,
      vi.fn(),
    );

    expect(result).toBe('done');
    expect(calls).toEqual(['reserve', 'getResult']);
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('passes coalesced and signal through to reserveUsage/refundUsage', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const getResult = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withReservedUsage({ reserveUsage, refundUsage }, true, getResult, controller.signal, vi.fn()),
    ).rejects.toThrow('fail');

    expect(reserveUsage).toHaveBeenCalledWith({ coalesced: true, signal: controller.signal });
    expect(refundUsage).toHaveBeenCalledWith({ coalesced: true, signal: controller.signal });
  });

  it('wraps a reserveUsage failure in a quota_exceeded LLMError and never calls getResult', async () => {
    const reserveUsage = vi.fn().mockRejectedValue(new Error('no budget left'));
    const getResult = vi.fn();

    await expect(
      withReservedUsage({ reserveUsage }, false, getResult, undefined, vi.fn()),
    ).rejects.toMatchObject({ type: 'quota_exceeded', message: 'no budget left' });

    expect(getResult).not.toHaveBeenCalled();
  });

  it('refunds when getResult throws after a successful reservation, then rethrows the original error', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const originalError = new Error('call failed');
    const getResult = vi.fn().mockRejectedValue(originalError);

    await expect(
      withReservedUsage({ reserveUsage, refundUsage }, false, getResult, undefined, vi.fn()),
    ).rejects.toBe(originalError);

    expect(refundUsage).toHaveBeenCalledOnce();
  });

  it('does not attempt a refund when getResult fails and no reservation was ever made', async () => {
    const refundUsage = vi.fn();
    const getResult = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      withReservedUsage({ refundUsage }, false, getResult, undefined, vi.fn()),
    ).rejects.toThrow('boom');

    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('reports a failing refundUsage via onRefundError instead of throwing or masking the original error', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockRejectedValue(new Error('refund boom'));
    const originalError = new Error('call failed');
    const getResult = vi.fn().mockRejectedValue(originalError);
    const onRefundError = vi.fn();

    await expect(
      withReservedUsage({ reserveUsage, refundUsage }, false, getResult, undefined, onRefundError),
    ).rejects.toBe(originalError);

    expect(onRefundError).toHaveBeenCalledWith('[VernLLM] refundUsage failed', expect.any(Error));
  });

  it('classifies as aborted, not quota_exceeded, when the signal aborts while reserveUsage is pending', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('reservation rejected after abort');
    });
    const getResult = vi.fn();

    await expect(
      withReservedUsage({ reserveUsage }, false, getResult, controller.signal, vi.fn()),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(getResult).not.toHaveBeenCalled();
  });

  it('short-circuits with an aborted LLMError before reserveUsage runs at all, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const getResult = vi.fn();

    await expect(
      withReservedUsage(
        { reserveUsage, refundUsage },
        false,
        getResult,
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(reserveUsage).not.toHaveBeenCalled();
    expect(getResult).not.toHaveBeenCalled();
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('refunds and reports aborted when the signal fires while getResult is in flight', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const getResult = vi.fn().mockImplementation(async () => {
      controller.abort();
      return 'late value';
    });

    await expect(
      withReservedUsage(
        { reserveUsage, refundUsage },
        false,
        getResult,
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(refundUsage).toHaveBeenCalledOnce();
  });
});

describe('withReservedUsageForStream', () => {
  it('refunds and rejects as aborted, without ever calling openStream, when the signal aborts while reserveUsage is pending', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockImplementation(async () => {
      controller.abort();
    });
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const openStream = vi.fn();

    await expect(
      withReservedUsageForStream(
        { reserveUsage, refundUsage },
        openStream,
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(openStream).not.toHaveBeenCalled();
    expect(refundUsage).toHaveBeenCalledOnce();
  });

  it('refunds immediately when openStream itself throws, before any chunks/finalResult exist', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const openError = new Error('failed to open stream');
    const openStream = vi.fn().mockRejectedValue(openError);

    await expect(
      withReservedUsageForStream({ reserveUsage, refundUsage }, openStream, undefined, vi.fn()),
    ).rejects.toBe(openError);

    expect(refundUsage).toHaveBeenCalledOnce();
  });

  it('does not refund when finalResult resolves successfully', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn();
    const openStream = vi.fn().mockResolvedValue({
      chunks: (async function* () {})(),
      finalResult: Promise.resolve('done'),
    });

    const { finalResult } = await withReservedUsageForStream(
      { reserveUsage, refundUsage },
      openStream,
      undefined,
      vi.fn(),
    );

    await expect(finalResult).resolves.toBe('done');
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('defers the refund until finalResult rejects, not until openStream returns', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const streamError = new Error('stream failed mid-flight');

    // A pending promise, settled explicitly below, so the assertion before
    // that point genuinely proves the refund waits for real settlement
    // rather than an already-rejected promise's microtask ordering.
    let rejectStream!: (error: unknown) => void;
    const pendingFinalResult = new Promise<never>((_, reject) => {
      rejectStream = reject;
    });
    const openStream = vi.fn().mockResolvedValue({
      chunks: (async function* () {})(),
      finalResult: pendingFinalResult,
    });

    const { finalResult } = await withReservedUsageForStream(
      { reserveUsage, refundUsage },
      openStream,
      undefined,
      vi.fn(),
    );

    // The refund only happens once finalResult itself settles, not as a
    // side effect of openStream resolving.
    expect(refundUsage).not.toHaveBeenCalled();

    rejectStream(streamError);

    await expect(finalResult).rejects.toBe(streamError);

    expect(refundUsage).toHaveBeenCalledOnce();
  });

  it('reports a failing refundUsage via onRefundError after a stream error, without masking the original error', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockRejectedValue(new Error('refund boom'));
    const streamError = new Error('stream failed');
    const openStream = vi.fn().mockResolvedValue({
      chunks: (async function* () {})(),
      finalResult: Promise.reject(streamError),
    });
    const onRefundError = vi.fn();

    const { finalResult } = await withReservedUsageForStream(
      { reserveUsage, refundUsage },
      openStream,
      undefined,
      onRefundError,
    );

    await expect(finalResult).rejects.toBe(streamError);

    expect(onRefundError).toHaveBeenCalledWith(
      '[VernLLM] refundUsage failed after stream error',
      expect.any(Error),
    );
  });
});
