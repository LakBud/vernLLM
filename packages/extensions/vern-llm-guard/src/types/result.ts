/** What one check did in one phase. Counts and ids only, never content or offsets. */
export interface CheckReport {
  /** How many things it found. */
  found: number;
  /** The fine labels of what it found, once each. Absent when none. */
  kinds?: string[];
  /** Time spent in the detector, in milliseconds. */
  ms: number;
  /** How many segments were answered from the call's cache or the memo. Absent when none. */
  memo?: number;
  /** Findings of a `redact` check that had no offsets, which made it block. Absent when none. */
  unredactable?: number;
}

/** A check that threw, timed out or returned something invalid. Never its message. */
export interface CheckError {
  /** Absent when the guard itself failed, not one of its checks. */
  check?: string;
  name: string;
}

export type AuditEffect = 'label' | 'redact' | 'block';

export interface PhaseReport {
  checks: Record<string, CheckReport>;
  /** Checks in audit mode that found something, and what they would have done. */
  audit: Record<string, AuditEffect>;
  errors: CheckError[];
  /** Findings in text other middleware added after the guard decided. */
  late: number;
  /** Things no detector could scan, such as images. */
  unscanned: number;
}

/** What happened to the answer. */
export interface OutputReport extends Omit<PhaseReport, 'unscanned'> {
  /** Tokens turned back into the values they stood for. */
  restored: number;
  /** Token shaped text that stood for no value of this call, such as one the model mangled. */
  unrestored: number;
}

/** The strongest effect across the call. */
export type GuardOutcome = 'passed' | 'labeled' | 'redacted' | 'blocked';

/** The `guard.result` event, one per call. Shape version `1`. */
export interface GuardResult {
  v: 1;
  version: string;
  outcome: GuardOutcome;
  /** What policy saw. Absent when unknown. */
  labels?: string[];
  input: PhaseReport;
  /** Absent when the call never got an answer. */
  output?: OutputReport;
}
