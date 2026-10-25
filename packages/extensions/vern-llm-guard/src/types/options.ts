import type { AttemptContext, Logger, PreDispatchContext, WireMessage } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/** Where a piece of text came from. `'output'` is the model's answer. */
export type Source = 'user' | 'tool' | 'system' | 'assistant' | 'output';

/** One piece of text a detector scans. */
export interface Segment {
  text: string;
  source: Source;
}

/**
 * One thing a detector found. `segment` is an index into the segments the detector was given.
 * `start` and `end` are offsets into that segment's text, end exclusive.
 */
export interface Finding {
  segment: number;
  /** The fine grained kind, such as `email`. Kept in the result, never shown to policy. */
  label?: string;
  start?: number;
  end?: number;
}

/**
 * Finds things in text. A detector is a pure function of its segments: the memo and `evaluate`
 * depend on it. It gets every segment that needs scanning in one call, and returns only the findings
 * it stands behind. Returning an array keeps the scan synchronous.
 */
export type Detector = (
  segments: readonly Segment[],
  signal: AbortSignal,
) => Finding[] | Promise<Finding[]>;

/** What a check can be pointed at. `'input'` is every role of the request. */
export type CheckOn = 'input' | 'user' | 'tool' | 'system' | 'assistant' | 'output';

/**
 * What a check does with a finding. Every action also labels the call.
 *
 * `'redact'` swaps the value for a token on the way in, and puts the value back on the way out. On
 * an `'output'` check it masks the value for good. It needs findings with offsets: a finding
 * without them blocks the call instead.
 */
export type CheckAction = 'label' | 'redact' | 'block';

/** What the guard knows about a call before it decides whether a check applies. */
export type CheckContext = Pick<PreDispatchContext, 'context' | 'streaming'>;

export interface Check {
  /** Unique and stable: it is in results, errors and logs. */
  id: string;
  detect: Detector;
  /** What is scanned: the request, its roles, or the model's answer. Default `['input']`. */
  on?: CheckOn | readonly CheckOn[];
  /** Default `'label'`. */
  action?: CheckAction;
  /** The label policy sees when this check finds something. Default: the `id`. */
  label?: string;
  /** Whether the check applies to this call. Omitted: always. */
  when?: (ctx: CheckContext) => boolean;
  /**
   * `redact` only: whether to redact for this attempt's target. Omitted: every target. A self hosted
   * model can get the raw text while an external one gets tokens.
   */
  redactFor?: (ctx: AttemptContext) => boolean;
  /**
   * `redact` only: whether the values come back in the answer. Default `true`. `false` masks them
   * instead, so they never reach the caller.
   */
  restore?: boolean;
  /**
   * `block` on input only: start with the call instead of before it, so a slow classifier adds no
   * latency to calls that pass. The answer is held until it finishes. It runs after policy decided,
   * so it cannot label or redact. A plain answer that it blocks was already generated and billed.
   */
  parallel?: boolean;
  /** `'audit'` reports the would be effect and changes nothing. Default `'enforce'`. */
  mode?: 'enforce' | 'audit';
  /** Default 2000, never past the call's deadline. */
  timeoutMs?: number;
  /** What a failing detector means. Default: the instance's `onError`. */
  onError?: 'closed' | 'open';
}

export interface GuardOptions {
  /** Names this set of checks. It is in every result, and the memo is keyed by it. */
  version: string;
  checks: readonly Check[];
  /** Findings remembered per text. `false` turns the memo off. Default `{ max: 10_000 }`. */
  memo?: false | { max?: number };
  /**
   * Keys the tokens, at least 32 bytes. Set it to keep tokens stable across processes. Default: a
   * random key per process, which is enough because nothing is stored.
   */
  key?: string | Uint8Array;
  /** The text that replaces a masked value, from its label. Default `[EMAIL]` style. */
  mask?: (label: string) => string;
  /** How a streamed answer is checked and released. */
  stream?: StreamOptions;
  /** Marks untrusted text so the model can tell data from instructions. Off by default. */
  spotlight?: SpotlightOptions;
  /** The default for checks that do not set their own. Default `'closed'`. */
  onError?: 'closed' | 'open';
  /** Where the guard reports its own failures. Default: a console logger. */
  logger?: LoggerOption;
}

/** How a streamed answer is checked on its way to the caller. */
export interface StreamOptions {
  /**
   * `'checked'` (default) sends text only after every check covering it passed. `'immediate'` sends
   * it first and checks after, so a block ends the stream but cannot take back what was sent.
   */
  release?: 'checked' | 'immediate';
  /** Text held back so a value split across chunks is caught. At least 32, default 128. */
  holdChars?: number;
  /** How much new text a slow check waits for before it runs again. Above `holdChars`, default 1000. */
  windowChars?: number;
}

/** What `evaluate` is given: a request as messages, or plain text, and which phase it stands for. */
export interface EvaluateInput {
  /** A request, as the guard would see it on the way in. */
  messages?: readonly WireMessage[];
  /** One piece of text. With `phase: 'input'` it is treated as a user message. */
  text?: string;
  /** `'input'` (default) or `'output'`: which checks apply. `messages` is for `'input'` only. */
  phase?: 'input' | 'output';
  /** What a check's `when` reads as `ctx.context`. */
  context?: CheckContext['context'];
}

/** What `update` swaps in. The rest of the options stay as they were. */
export interface GuardUpdate {
  checks: readonly Check[];
  /** Names the new set. It must differ from the current one, since results and the memo use it. */
  version: string;
  /** Merged into the current stream options, so leaving a field out keeps its value. */
  stream?: StreamOptions;
}

/**
 * Datamarking against prompt injection. Spaces in the text of the listed sources become a marker,
 * and one sentence in the system message says marked text is data and never instructions. The
 * marker is random per instance and changes with `version`, so the system message stays stable for
 * provider prompt caching. A marker the model echoes is removed from the answer. It changes what
 * the model reads, so test it on your own use case.
 */
export interface SpotlightOptions {
  /** What to mark: any of `'tool'`, `'user'`, `'assistant'`. Default `['tool']`. */
  sources?: readonly ('tool' | 'user' | 'assistant')[];
}
