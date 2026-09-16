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
local from = state

if outcome == 'check' then
  if state == 'open' and (now - openedAt) >= cooldownMs then
    state = 'half-open'
  end
elseif outcome == 'success' then
  failures = 0
  state = 'closed'
elseif outcome == 'failure' then
  failures = failures + 1
  if state == 'half-open' or (state == 'closed' and failures >= threshold) then
    state = 'open'
    openedAt = now
  end
end

redis.call('HSET', key, 'state', state, 'failures', failures, 'openedAt', openedAt)
redis.call('PEXPIRE', key, cooldownMs * 4)

if from ~= state then
  redis.call('PUBLISH', channel, key .. '|' .. state .. '|' .. failures .. '|' .. openedAt)
end

return { from, state, tostring(failures) }
`;

export interface TransitionResult {
  from: CircuitState;
  to: CircuitState;
  failures: number;
}

/** Parses TRANSITION_SCRIPT's raw eval() return value into a typed result. */
export function parseTransitionResult(raw: unknown): TransitionResult {
  const [from, to, failures] = raw as [string, string, string];
  return { from: from as CircuitState, to: to as CircuitState, failures: Number(failures) };
}

/**
 * Parses a pub/sub message published by TRANSITION_SCRIPT's own PUBLISH
 * above: `${key}|${state}|${failures}|${openedAt}`. Returns undefined for
 * a message that doesn't match that shape, malformed input from a
 * channel this adapter doesn't fully control the traffic on should be
 * ignored, not thrown on.
 */
export function parseTransitionMessage(
  message: string,
): { key: string; state: CircuitState; failures: number; openedAt: number } | undefined {
  const [key, state, failuresRaw, openedAtRaw] = message.split('|');
  if (!key || !state) return undefined;

  return {
    key,
    state: state as CircuitState,
    failures: Number(failuresRaw),
    openedAt: Number(openedAtRaw),
  };
}
