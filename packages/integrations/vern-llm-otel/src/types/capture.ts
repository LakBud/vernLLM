import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

export interface CaptureContentOptions {
  /** Default true. */
  input?: boolean;
  /** Default true. */
  output?: boolean;
  /** Default true. */
  systemInstructions?: boolean;
  /** Default false, can be large. */
  toolDefinitions?: boolean;
  /** Max characters per captured attribute. Positive integer or Infinity. Default 8192. */
  maxLength?: number;
  /** Runs on every text piece before it is recorded. */
  redact?: (text: string) => string;
  /**
   * Decides, once per logical call, whether content is captured for that call. Sync only.
   * Only a return value of exactly `true` enables capture. Throwing, returning anything else,
   * or returning a promise means no capture (fail closed). Receives the unredacted request,
   * so do not log or forward it.
   */
  when?: (ctx: PreDispatchContext, request: Readonly<WireCallRequest>) => boolean;
}
