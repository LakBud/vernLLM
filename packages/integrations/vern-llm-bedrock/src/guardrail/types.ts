import type {
  ApplyGuardrailCommand,
  ApplyGuardrailCommandOutput,
  GuardrailUsage,
} from '@aws-sdk/client-bedrock-runtime';
import type { CallMeta, Logger } from 'vern-llm';

/** Where a piece of text came from. `'output'` is the model's answer, everything else is input. */
export type Source = 'user' | 'tool' | 'system' | 'assistant' | 'output';

/** One piece of text a detector reads. */
export interface Segment {
  text: string;
  source: Source;
}

/** One image a detector reads. Only a detector with `images: true` is given one. */
export interface ImageSegment {
  /** `data` is base64 with no `data:` prefix. */
  image: { data: string; mimeType: string };
  source: Source;
}

/**
 * One thing a detector found. `segment` is an index into the segments it was given. `start` and
 * `end` are offsets into that segment's text, end exclusive, and are left out when the whole text
 * is meant. An image has no text, so a finding on one has no offsets.
 */
export interface Finding {
  segment: number;
  label?: string;
  start?: number;
  end?: number;
  /** The detector did not read this segment, such as an image of a format Bedrock cannot take. */
  unscanned?: true;
}

/** The call around the text a detector judges. Set for output checks. */
export interface CallView {
  /** The request's text, as the provider saw it: a value that was replaced is its token. */
  input: readonly Segment[];
  /** What answered the call. Absent while a stream is still arriving. */
  meta?: CallMeta;
}

type DetectorFindings = Finding[] | Promise<Finding[]>;

/**
 * A detector: a function from text segments to findings. `images: true` also gives it image
 * segments, and `callView: true` gives it the call as the third argument.
 */
export type Detector = ((
  segments: readonly Segment[],
  signal: AbortSignal,
  call?: CallView,
) => DetectorFindings) & {
  readonly images?: true;
  readonly callView?: true;
};

/** A detector that also reads images. It fits wherever a `Detector` does. */
export type ImageDetector = ((
  segments: readonly (Segment | ImageSegment)[],
  signal: AbortSignal,
  call?: CallView,
) => DetectorFindings) & {
  readonly images: true;
  readonly callView?: true;
};

/** What `grounding(...)` is given. */
export interface GroundingOptions {
  /** The input that counts as the source of truth. Default `['tool']`, the tool results. */
  sources?: readonly Exclude<Source, 'output'>[];
  /**
   * A question over 1000 characters: `'tail'` (default) sends its last 1000, since a question
   * usually ends the message, and `'error'` fails the check.
   */
  queryOverflow?: 'tail' | 'error';
}

/** A detector that judges the answer against the call. It reads the call, so it is an output check. */
export type GroundingDetector = Detector & { readonly callView: true };

/** The kinds of finding a guardrail reports, as in `only(...)`. */
export const GUARDRAIL_KINDS = ['pii', 'regex', 'word', 'topic', 'content'] as const;

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

/** A detector, and the same detector narrowed to some kinds of finding. */
export type GuardrailDetector = Detector & {
  /** Another detector over the same requests and cache, returning only these kinds. */
  only(...kinds: GuardrailKind[]): Detector;
  /** Judges the answer against the call's tool results, with the guardrail's grounding check. */
  grounding(options?: GroundingOptions): GroundingDetector;
};

/** Just what the detector needs of a client. A `BedrockRuntimeClient` fits. */
export interface GuardrailClient {
  send(
    command: ApplyGuardrailCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Partial<Pick<ApplyGuardrailCommandOutput, 'assessments' | 'usage'>>>;
}

/** What one `ApplyGuardrail` request cost. */
export interface GuardrailUsageInfo {
  guardrailIdentifier: string;
  guardrailVersion: string;
  /** The policy units the response reports. */
  usage: GuardrailUsage | undefined;
  /** Milliseconds the request took. */
  ms: number;
}

export interface BedrockGuardrailOptions {
  client: GuardrailClient;
  guardrailIdentifier: string;
  /** A published version. `'DRAFT'` warns once and turns the cache off, since it can change. */
  guardrailVersion: string;
  /** Requests in flight at once. An integer of at least 1, default 4. */
  concurrency?: number;
  /**
   * Also check the images in a request, one request each. Default `false`, so images are never
   * sent to Bedrock unless you ask. PNG and JPEG only, up to 4 MB and 8000 by 8000 pixels.
   */
  images?: boolean;
  /**
   * With `images`, what an image Bedrock cannot take means. `'error'` (default) fails the check, so
   * `onError` decides and `closed` blocks the call. `'skip'` leaves it unread and counts it as
   * unscanned.
   */
  unsupportedImages?: 'error' | 'skip';
  /** With `images`, images in flight at once, within `concurrency`. At least 1, default 4. */
  imageConcurrency?: number;
  /** Findings remembered per source and text. `false` turns it off. Default `{ max: 10_000 }`. */
  cache?: false | { max?: number };
  /** Longer texts are split in chunks of this size, at least 1000. Default 12000. */
  chunkChars?: number;
  /** How much of the previous chunk the next one starts with. Below `chunkChars`. Default 200. */
  overlapChars?: number;
  /** Called for each request with what it cost. A throw is ignored. */
  onUsage?: (info: GuardrailUsageInfo) => void;
  /** Where the `DRAFT` warning goes. Default: a console logger. */
  logger?: Logger | 'silent';
}
