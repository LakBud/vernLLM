import type {
  ApplyGuardrailCommand,
  ApplyGuardrailCommandOutput,
  GuardrailUsage,
} from '@aws-sdk/client-bedrock-runtime';
import type { Logger } from 'vern-llm';

/** Where a piece of text came from. `'output'` is the model's answer, everything else is input. */
export type Source = 'user' | 'tool' | 'system' | 'assistant' | 'output';

/** One piece of text a detector reads. */
export interface Segment {
  text: string;
  source: Source;
}

/**
 * One thing a detector found. `segment` is an index into the segments it was given. `start` and
 * `end` are offsets into that segment's text, end exclusive, and are left out when the whole text
 * is meant.
 */
export interface Finding {
  segment: number;
  label?: string;
  start?: number;
  end?: number;
}

/** A detector: a function from text segments to findings. */
export type Detector = (
  segments: readonly Segment[],
  signal: AbortSignal,
) => Finding[] | Promise<Finding[]>;

/** The kinds of finding a guardrail reports, as in `only(...)`. */
export const GUARDRAIL_KINDS = ['pii', 'regex', 'word', 'topic', 'content'] as const;

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

/** A detector, and the same detector narrowed to some kinds of finding. */
export type GuardrailDetector = Detector & {
  /** Another detector over the same requests and cache, returning only these kinds. */
  only(...kinds: GuardrailKind[]): Detector;
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
