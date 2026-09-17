import type { CircuitState } from 'vern-llm';

/**
 * Atomically reads, transitions, and writes one circuit's state in Redis,
 * and publishes the new state on `channel` whenever a real transition
 * happens, so every subscribed process can update immediately. `outcome`
 * is 'check' (pre dispatch), 'success', or 'failure'.
 */
export const TRANSITION_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local cooldownMs = tonumber(ARGV[3])
local outcome = ARGV[4]
local channel = ARGV[5]

local state = redis.call('HGET', key, 'state')
if not state then state = 'closed' end
local failures = tonumber(redis.call('HGET', key, 'failures') or '0')
local openedAt = tonumber(redis.call('HGET', key, 'openedAt') or '0')
local probeHeld = redis.call('HGET', key, 'probeHeld')
if not probeHeld then probeHeld = '0' end
local from = state
-- True only when THIS exact invocation is the one that flips
-- probeHeld from '0' to '1'. Since every eval is atomic, exactly one
-- process's 'check' call across the whole fleet ever sees this true
-- for a given open->half-open transition; every other process, even
-- though it also ends up reading state == 'half-open' afterward, gets
-- wonProbe == false and must not grant its own caller a trial.
local wonProbe = false

if outcome == 'check' then
  if state == 'open' and (now - openedAt) >= cooldownMs then
    -- Only the first 'check' to reach this point across every process
    -- (Redis serializes each eval, so this branch runs atomically) wins
    -- the single half-open trial lease. Every other process's 'check'
    -- while the lease is held sees probeHeld == '1' and stays 'open'
    -- from its own perspective until this HSET below, after which it
    -- too reads state == 'half-open' but with wonProbe == false.
    if probeHeld ~= '1' then
      state = 'half-open'
      probeHeld = '1'
      wonProbe = true
    end
  end
elseif outcome == 'success' then
  failures = 0
  state = 'closed'
  probeHeld = '0'
elseif outcome == 'failure' then
  failures = failures + 1
  probeHeld = '0'
  if state == 'half-open' or (state == 'closed' and failures >= threshold) then
    state = 'open'
    openedAt = now
  end
end

redis.call('HSET', key, 'state', state, 'failures', failures, 'openedAt', openedAt, 'probeHeld', probeHeld)
redis.call('PEXPIRE', key, cooldownMs * 4)

if from ~= state then
  -- Structured JSON, not '|'-joined fields: a key containing '|' (an
  -- isolateByModel model name is caller-supplied) would otherwise split
  -- into the wrong number of parts and desync the subscriber's parse.
  local payload = cjson.encode({ key = key, state = state, failures = failures, openedAt = openedAt })
  redis.call('PUBLISH', channel, payload)
end

return { from, state, tostring(failures), wonProbe and '1' or '0', tostring(openedAt) }
`;

export interface TransitionResult {
  from: CircuitState;
  to: CircuitState;
  failures: number;
  /** True only for the single caller, across every process, whose 'check' call actually won this open->half-open transition. See TRANSITION_SCRIPT's wonProbe. */
  wonProbe: boolean;
  /** Redis's own committed openedAt for this bucket, not a client-side reconstruction. */
  openedAt: number;
}

/** Parses TRANSITION_SCRIPT's raw eval() return value into a typed result. */
export function parseTransitionResult(raw: unknown): TransitionResult {
  const [from, to, failures, wonProbe, openedAt] = raw as [string, string, string, string, string];
  return {
    from: from as CircuitState,
    to: to as CircuitState,
    failures: Number(failures),
    wonProbe: wonProbe === '1',
    openedAt: Number(openedAt),
  };
}

const VALID_CIRCUIT_STATES: ReadonlySet<string> = new Set(['closed', 'open', 'half-open']);

/**
 * Parses a pub/sub message published by TRANSITION_SCRIPT's own PUBLISH
 * above: a JSON object `{ key, state, failures, openedAt }`. Returns
 * undefined for anything that isn't valid, well-shaped JSON, malformed
 * input from a channel this adapter doesn't fully control the traffic on
 * should be ignored, not thrown on.
 */
export function parseTransitionMessage(
  message: string,
): { key: string; state: CircuitState; failures: number; openedAt: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { key, state, failures, openedAt } = parsed as Record<string, unknown>;

  if (typeof key !== 'string' || !key) return undefined;
  if (typeof state !== 'string' || !VALID_CIRCUIT_STATES.has(state)) return undefined;
  if (typeof failures !== 'number' || !Number.isFinite(failures)) return undefined;
  if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) return undefined;

  return { key, state: state as CircuitState, failures, openedAt };
}
