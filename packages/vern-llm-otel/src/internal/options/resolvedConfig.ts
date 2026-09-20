import type { LoggerOption } from '../guard.utils.js';
import type { Attributes, Meter, Tracer } from '@opentelemetry/api';
import type {
  MiddlewareRef,
  PreDispatchContext,
  RequiredMiddlewareRef,
  WireCallRequest,
} from 'vern-llm';

export interface ResolvedCapture {
  input: boolean;
  output: boolean;
  systemInstructions: boolean;
  toolDefinitions: boolean;
  maxLength: number;
  redact: ((text: string) => string) | undefined;
  when: ((ctx: PreDispatchContext, request: Readonly<WireCallRequest>) => boolean) | undefined;
  /** False when every group is off, so nothing is ever recorded and `when` is never consulted. */
  anyGroup: boolean;
}

/** Every option validated and defaulted once, so no other file repeats a default. */
export interface ResolvedConfig {
  tracer: Tracer | undefined;
  meter: Meter | undefined;
  metrics: boolean;
  genAiConventions: boolean;
  normalizeModel: ((model: string) => string) | undefined;
  attributes: ((ctx: PreDispatchContext) => Attributes | undefined) | undefined;
  middlewareEvents: boolean;
  /** `undefined` when exception recording is off. */
  exceptions: { stack: boolean } | undefined;
  logger: LoggerOption | undefined;
  name: string;
  priority: number;
  runsAfter: (MiddlewareRef | RequiredMiddlewareRef)[];
  /** `undefined` when content capture is off. */
  capture: ResolvedCapture | undefined;
  /** Mapped `gen_ai.provider.name`, falling back to the raw target label. */
  providerName(label: string): string;
}
