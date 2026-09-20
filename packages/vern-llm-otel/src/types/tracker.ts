import type { Guard } from '../internal/guard.utils.js';
import type { Metrics } from '../internal/metrics/metrics.utils.js';
import type { ResolvedConfig } from './resolvedConfig.js';
import type { Span, Tracer } from '@opentelemetry/api';
import type { CallResult, PreDispatchContext, WireCallRequest } from 'vern-llm';

/**
 * What the tracker needs from content capture. Kept as an interface so the tracker never
 * reads raw messages itself and a call with capture off pays nothing.
 */
export interface ContentCapture {
  /** Decides once per call whether content is recorded for it. Must fail closed. */
  decide(ctx: PreDispatchContext, request: Readonly<WireCallRequest>, span: Span): boolean;
  captureInput(span: Span, request: Readonly<WireCallRequest>): void;
  captureOutput(span: Span, value: unknown): void;
}

export interface TrackerDeps {
  config: ResolvedConfig;
  guard: Guard;
  metrics: Metrics;
  /** Resolved on use, so an SDK registered after the middleware was built is still picked up. */
  getTracer(): Tracer;
  content?: ContentCapture;
}

/** Wraps a thrown value, so a rejection with `undefined` is still distinguishable from success. */
export interface Failure {
  error: unknown;
}

export type Outcome =
  | { kind: 'result'; result: CallResult }
  | { kind: 'error'; error: unknown }
  | { kind: 'streamSettled'; value?: unknown; failure?: Failure };
