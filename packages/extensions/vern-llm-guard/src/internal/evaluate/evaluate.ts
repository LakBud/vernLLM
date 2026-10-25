import { scan } from '../scan/scan.js';
import { outputSegments } from '../segments/outputSegments.utils.js';
import { requestSegments } from '../segments/requestSegments.utils.js';

import type {
  EvaluateInput,
  GuardOutcome,
  GuardResult,
  PhaseReport,
  Segment,
} from '../../types/index.js';
import type { CompiledChecks } from '../../types/resolvedConfig.js';
import type { Memo, ScanResult } from '../scan/types.js';

const fail = (message: string): never => {
  throw new TypeError(`guardMiddleware: ${message}`);
};

const emptyInput = (): PhaseReport => ({
  checks: {},
  audit: {},
  errors: [],
  late: 0,
  unscanned: 0,
});

/** The segments of what `evaluate` was given, read the way a call reads it. */
function segmentsOf(
  input: EvaluateInput,
  phase: 'input' | 'output',
): { segments: Segment[]; unscanned: number } {
  if (input.messages !== undefined) return requestSegments(input.messages);
  if (phase === 'output') return { segments: outputSegments(input.text).segments, unscanned: 0 };
  return { segments: [{ text: input.text!, source: 'user' }], unscanned: 0 };
}

/** Checks what `evaluate` was given, and says which phase it stands for. */
function phaseOf(input: EvaluateInput): 'input' | 'output' {
  if (typeof input !== 'object' || input === null) fail('evaluate needs an object');
  if ((input.messages === undefined) === (input.text === undefined)) {
    fail('evaluate needs messages or text, not both and not neither');
  }
  const phase = input.phase ?? 'input';
  if (phase !== 'input' && phase !== 'output') fail("evaluate phase must be 'input' or 'output'");
  if (phase === 'output' && input.messages !== undefined) {
    fail("evaluate takes text, not messages, for phase 'output'");
  }
  return phase;
}

/** The strongest effect of what the scan found. */
function outcomeOf(scanned: ScanResult): GuardOutcome {
  if (scanned.blocked !== undefined) return 'blocked';
  if (scanned.findings.some(({ check }) => check.action === 'redact')) return 'redacted';
  if (scanned.labels.length > 0) return 'labeled';
  return 'passed';
}

/**
 * The result a call would have emitted for this data, with no call made. Every check runs, the
 * ones marked `parallel` included, before anything else.
 */
export async function evaluate(
  compiled: CompiledChecks,
  memo: Memo | undefined,
  input: EvaluateInput,
): Promise<GuardResult> {
  const phase = phaseOf(input);
  const { segments, unscanned } = segmentsOf(input, phase);

  const scanned = await scan(compiled, segments, new Map(), {
    memo,
    ctx: { context: input.context, streaming: false },
  });

  const head = {
    v: 1 as const,
    version: compiled.version,
    outcome: outcomeOf(scanned),
    ...(!scanned.unknown && { labels: scanned.labels }),
  };
  if (phase === 'input') return { ...head, input: { ...scanned.report, unscanned } };

  const { unscanned: _unscanned, ...report } = scanned.report;
  return { ...head, input: emptyInput(), output: { ...report, restored: 0, unrestored: 0 } };
}
