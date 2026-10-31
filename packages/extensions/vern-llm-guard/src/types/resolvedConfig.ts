import type { CheckContext, Detector, Source } from './options.js';
import type { AttemptContext } from 'vern-llm';

/** One check with defaults filled in and `on` expanded. */
export interface CompiledCheck {
  readonly id: string;
  readonly detect: Detector;
  /** The roles of the request this check scans, and `output` for the answer. */
  readonly sources: ReadonlySet<Source>;
  readonly action: 'label' | 'redact' | 'block';
  readonly label: string;
  readonly when: ((ctx: CheckContext) => boolean) | undefined;
  readonly redactFor: ((ctx: AttemptContext) => boolean) | undefined;
  /** Whether redacted values come back in the answer. */
  readonly restore: boolean;
  /** Runs alongside the call, and can only block. */
  readonly parallel: boolean;
  readonly audit: boolean;
  readonly timeoutMs: number;
  /** Whether a failing detector refuses (`true`) or is skipped (`false`). */
  readonly failClosed: boolean;
  /** Whether the detector also reads image segments. */
  readonly images: boolean;
  /** Whether the detector is given the call, and so is never memoized. */
  readonly callView: boolean;
}

/** A validated, frozen set of options. A call reads one from start to end. */
export interface CompiledChecks {
  readonly version: string;
  readonly checks: readonly CompiledCheck[];
  /** The memo's size, `0` for none. */
  readonly memoMax: number;
  readonly failClosed: boolean;
  /** The text for a masked value. */
  readonly mask: (label: string) => string;
  /** The key tokens are made with, when the options set one. */
  readonly key: Buffer | undefined;
  readonly stream: CompiledStream;
  /** The checks that run before the call; `undefined` when none runs alongside it. */
  readonly serial: ReadonlySet<string> | undefined;
  /** The checks that run alongside the call. */
  readonly parallel: readonly CompiledCheck[];
  /** What to mark, when spotlight is on. */
  readonly spotlight: ReadonlySet<Source> | undefined;
  /** Whether some check reads user images, so the request's images are cut into segments. */
  readonly images: boolean;
}

export interface CompiledStream {
  readonly release: 'checked' | 'immediate';
  readonly holdChars: number;
  readonly windowChars: number;
}
