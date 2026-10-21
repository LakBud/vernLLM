import type { CircuitState } from 'vern-llm';

export interface TransitionResult {
  from: CircuitState;
  to: CircuitState;
  failures: number;
  /** True only for the one caller, across processes, that won a half-open slot. */
  wonProbe: boolean;
  /** Redis's own openedAt. */
  openedAt: number;
  /** The won slot's epoch, presented back on its outcome. Set only when `wonProbe`. */
  probeToken: string;
  /** Failures by error code, `unknown` without one. */
  breakdown: Record<string, number>;
  /** Redis's clock at the transition, in ms. */
  serverNow: number;
  /** The cooldown in force, in ms. */
  cooldownMs: number;
  /** When the latest slot was granted, on Redis's clock, or 0. */
  grantAt: number;
  /** Slots not yet handed out. */
  slots: number;
  /** The bucket's transition version. */
  version: number;
  /** The current half-open epoch, if the reply carries one. */
  epoch: string | undefined;
}

/** Parses `code=count,code=count`. */
function parseBreakdown(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'string' || raw === '') return out;

  for (const part of raw.split(',')) {
    const eq = part.lastIndexOf('=');
    if (eq <= 0) continue;

    const count = Number(part.slice(eq + 1));
    if (Number.isFinite(count)) out[part.slice(0, eq)] = count;
  }
  return out;
}

/** A TRANSITION_SCRIPT reply. Redis sends every field as a string, and some may be missing. */
type TransitionReply = [
  from: string,
  to: string,
  failures: string,
  wonProbe: string,
  openedAt: string,
  probeToken: string | undefined,
  breakdown: string | undefined,
  serverNow: string,
  cooldownMs: string,
  grantAt: string,
  slots: string,
  version: string | undefined,
  epoch: string | undefined,
];

/** Parses a TRANSITION_SCRIPT reply. */
export function parseTransitionResult(raw: unknown): TransitionResult {
  const [
    from,
    to,
    failures,
    wonProbe,
    openedAt,
    probeToken,
    breakdown,
    serverNow,
    cooldownMs,
    grantAt,
    slots,
    version,
    epoch,
  ] = raw as TransitionReply;

  return {
    from: from as CircuitState,
    to: to as CircuitState,
    failures: Number(failures),
    wonProbe: wonProbe === '1',
    openedAt: Number(openedAt),
    probeToken: probeToken ?? '',
    breakdown: parseBreakdown(breakdown),
    serverNow: Number(serverNow),
    cooldownMs: Number(cooldownMs),
    grantAt: Number(grantAt),
    slots: Number(slots),
    version: parseVersion(version),
    epoch: epoch || undefined,
  };
}

/** Missing or unreadable reads as 0, older than any version Redis writes. */
function parseVersion(raw: unknown): number {
  const version = Number(raw);
  return Number.isFinite(version) && version > 0 ? version : 0;
}

const VALID_CIRCUIT_STATES: ReadonlySet<string> = new Set(['closed', 'open', 'half-open']);

/** A published transition. */
export interface TransitionMessage {
  key: string;
  /** The state Redis moved away from. */
  from: CircuitState;
  state: CircuitState;
  failures: number;
  openedAt: number;
  serverNow: number;
  cooldownMs: number;
  slots: number;
  grantAt: number;
  version: number;
  /** The current half-open epoch. */
  epoch: string;
}

/** Numeric message fields, named as in the script's `cjson.encode`. */
const NUMERIC_MESSAGE_FIELDS = [
  'failures',
  'openedAt',
  'now',
  'cooldown',
  'slots',
  'grantAt',
  'ver',
  'epoch',
] as const;

/** Parses a published transition, or undefined for anything malformed. */
export function parseTransitionMessage(message: string): TransitionMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const { key, from, state } = record;

  if (typeof key !== 'string' || !key) return undefined;
  if (typeof state !== 'string' || !VALID_CIRCUIT_STATES.has(state)) return undefined;
  if (typeof from !== 'string' || !VALID_CIRCUIT_STATES.has(from)) return undefined;

  const numbers: Record<string, number> = {};
  for (const name of NUMERIC_MESSAGE_FIELDS) {
    const value = record[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    numbers[name] = value;
  }

  return {
    key,
    from: from as CircuitState,
    state: state as CircuitState,
    failures: numbers.failures!,
    openedAt: numbers.openedAt!,
    serverNow: numbers.now!,
    cooldownMs: numbers.cooldown!,
    slots: numbers.slots!,
    grantAt: numbers.grantAt!,
    version: numbers.ver!,
    epoch: String(numbers.epoch!),
  };
}

export type TransitionOutcome =
  | 'check'
  | 'success'
  | 'failure'
  | 'release'
  | 'renew'
  | 'open'
  | 'close';

/** Per adapter settings the script reads on every call. */
export interface TransitionConfig {
  threshold: number;
  cooldownMs: number;
  probeLeaseMs: number;
  halfOpenProbes: number;
  halfOpenSuccessRatio: number;
  backoff: { multiplier: number; maxMs?: number } | undefined;
  rolling: { windowMs: number; minCalls: number; failureRatio: number } | undefined;
}

/** What differs between transitions. */
export interface TransitionCall {
  outcome: TransitionOutcome;
  channel: string;
  /** '' means none, '*' means "no call context, always counts". */
  token: string;
  /** Whether a 'check' may win a half-open trial slot. */
  grant: boolean;
  code: string;
  /** In [0, 1) for the cooldown jitter, drawn by the caller so tests can pin it. */
  rand: number;
}

/** The script's ARGV after the key, in its fixed order. */
export function buildTransitionArgs(
  config: TransitionConfig,
  call: TransitionCall,
): (string | number)[] {
  return [
    call.outcome,
    call.channel,
    config.threshold,
    config.cooldownMs,
    config.probeLeaseMs,
    call.token,
    call.grant ? '1' : '0',
    config.halfOpenProbes,
    config.halfOpenSuccessRatio,
    config.backoff?.multiplier ?? 0,
    config.backoff?.maxMs ?? 0,
    call.rand,
    config.rolling?.windowMs ?? 0,
    config.rolling?.minCalls ?? 0,
    config.rolling?.failureRatio ?? 0,
    call.code,
  ];
}
