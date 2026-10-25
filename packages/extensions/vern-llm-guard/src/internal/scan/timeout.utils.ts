import type { Finding } from '../../types/index.js';

export class DetectorTimeoutError extends Error {
  override name = 'DetectorTimeoutError';
}

/**
 * How long a detector may take: its own limit, and never past the call's deadline. `deadlineAt` is
 * epoch milliseconds, or absent when the call has none.
 */
export function budgetFor(timeoutMs: number, deadlineAt: number | undefined): number {
  return Math.min(timeoutMs, Math.max(0, (deadlineAt ?? Infinity) - Date.now()));
}

/** Races a detector's promise against its budget, and aborts it when the budget runs out. */
export function withTimeout(
  answer: PromiseLike<Finding[]>,
  budget: number,
  controller: AbortController,
): Promise<Finding[]> {
  return new Promise<Finding[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new DetectorTimeoutError('a detector did not answer in time'));
    }, budget);
    timer.unref();
    answer.then(
      (found) => {
        clearTimeout(timer);
        resolve(found);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
