import type { OutputReport } from '../../types/index.js';
import type { CompiledChecks } from '../../types/resolvedConfig.js';
import type { CallCache, ScanDeps, ScanResult } from '../scan/types.js';
import type { TokenMap } from '../tokens/tokens.js';
import type { StreamChunk } from 'vern-llm';

export interface GateInput {
  compiled: CompiledChecks;
  /** The answer, as `CallResult.value` holds it. */
  value: unknown;
  tokens: TokenMap;
  cache: CallCache;
  deps: Omit<ScanDeps, 'skip' | 'only'>;
  /** The text is JSON, so a restored value is escaped to keep it valid. */
  json?: boolean;
  /** A spotlight marker the model may have echoed. It is removed first. */
  marker?: string | undefined;
}

export interface GateResult {
  /** The answer after the four steps. The same object when nothing changed. */
  value: unknown;
  report: OutputReport;
  /** Set when the answer must be refused instead of returned. */
  blocked?: ScanResult['blocked'];
  /** Values in the answer that an `output` check replaced for good. */
  masked: number;
  /** Time spent in the checks, in milliseconds. */
  ms: number;
}

export interface StreamSource {
  chunks: AsyncIterable<StreamChunk>;
  finalResult: Promise<unknown>;
}

/** How a stream ended, for the one result event of the call. */
export interface StreamDone {
  /** The whole answer's report when it was read, else what the stream saw. */
  report: OutputReport;
  masked: number;
  ms: number;
  blocked: boolean;
}

export interface StreamGateInput {
  compiled: CompiledChecks;
  source: StreamSource;
  tokens: TokenMap;
  cache: CallCache;
  deps: Omit<ScanDeps, 'skip' | 'only'>;
  /** The answer is JSON text, so restored values are escaped. */
  json: boolean;
  /** A spotlight marker the model may have echoed. It is removed as the text arrives. */
  marker?: string | undefined;
  /** Called once, when `finalResult` settles or the stream is refused. */
  onDone: (done: StreamDone) => void;
}
