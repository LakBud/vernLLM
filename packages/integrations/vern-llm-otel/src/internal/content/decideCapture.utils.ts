import type { ResolvedCapture } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { Span } from '@opentelemetry/api';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;

  try {
    return typeof (value as { then?: unknown }).then === 'function';
  } catch {
    // A `then` that throws when read is not something to trust as a plain answer.
    return true;
  }
}

/**
 * Decides once per call whether content is recorded. User code is not run when nothing could
 * be recorded anyway. Only a return value of exactly `true` enables capture: a throw, a
 * promise, or any other value means no.
 */
export function decideCapture(
  capture: ResolvedCapture,
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
  span: Span,
  guard: Guard,
): boolean {
  if (!capture.anyGroup || !span.isRecording()) return false;
  if (!capture.when) return true;

  const { when } = capture;
  const decision = guard<unknown>('captureContent.when', () => when(ctx, request), false);

  if (isThenable(decision)) {
    // Swallowed, so a rejecting promise does not also become an unhandled rejection.
    try {
      void Promise.resolve(decision).catch(() => {});
    } catch {
      // A hostile thenable that throws when observed is still just a refusal.
    }
    guard.report('captureContent.when', new Error('it must be synchronous but returned a promise'));
    return false;
  }

  return decision === true;
}
