import type { CircuitState } from 'vern-llm';

/**
 * Atomically reads, transitions, and writes one circuit's state in Redis,
 * and publishes the new state on `channel` whenever a real transition
 * happens, so every subscribed process can update immediately.
 *
 * ARGV, in order: outcome, channel, threshold, cooldownMs, leaseMs, token,
 * grant, probes, successRatio, backoffMultiplier, backoffMaxMs, rand,
 * rollingWindowMs, rollingMinCalls, rollingFailureRatio, code.
 *
 * `outcome` is 'check' (pre dispatch), 'success', 'failure', 'release'
 * (a call that claimed a trial ended without an outcome), 'open' or
 * 'close' (manual).
 *
 * Time comes from Redis (`TIME`), never from a caller: with a shared
 * key, one process's skewed clock would otherwise stamp `openedAt` and
 * lease deadlines that every other process then misreads.
 *
 * Half-open trials are handed out as numbered slots of one `epoch`. A
 * caller that wins a slot receives the epoch as its `token`, and a later
 * success, failure or release only counts if it presents that same
 * epoch (or '*', meaning "no call context, always counts", matching
 * core's CircuitBreaker). A late outcome from a call that started before
 * the trip, or from a holder whose lease was reclaimed, is ignored
 * instead of settling a trial it was never part of.
 *
 * The reply also carries Redis's own clock and the cooldown, lease and slot
 * state, and so does every published transition. They let an adapter judge
 * locally, without a round trip, when a refresh could change anything: an
 * open circuit whose cooldown has not run out cannot yet, so it is left alone.
 *
 * A slot whose holder never reports back (a crashed process, or one
 * that just stopped calling) abandons the trial once `leaseMs` has passed
 * since the last grant: a new epoch begins, so the old token is dead. `grant` is '0' for a background poll from a
 * process with no recent calls, so an idle process can never win a slot
 * it has no call to spend on.
 */
export const TRANSITION_SCRIPT = `
if redis.replicate_commands then redis.replicate_commands() end

local key = KEYS[1]
local outcome = ARGV[1]
local channel = ARGV[2]
local threshold = tonumber(ARGV[3])
local cooldownBase = tonumber(ARGV[4])
local leaseMs = tonumber(ARGV[5])
local token = ARGV[6]
local grant = ARGV[7] == '1'
local probes = tonumber(ARGV[8])
local ratioNeeded = tonumber(ARGV[9])
local backoffMult = tonumber(ARGV[10])
local backoffMax = tonumber(ARGV[11])
local rand = tonumber(ARGV[12])
local rollWindow = tonumber(ARGV[13])
local rollMin = tonumber(ARGV[14])
local rollRatio = tonumber(ARGV[15])
local code = ARGV[16]
if code == '' then code = 'unknown' end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local h = redis.call('HMGET', key,
  'state', 'failures', 'openedAt', 'epoch', 'slots', 'succ', 'tfail', 'grantAt', 'reopen', 'cooldown')
local state = h[1] or 'closed'
local failures = tonumber(h[2] or '0')
local openedAt = tonumber(h[3] or '0')
local epoch = tonumber(h[4] or '0')
local slots = tonumber(h[5] or '0')
local tsucc = tonumber(h[6] or '0')
local tfail = tonumber(h[7] or '0')
local grantAt = tonumber(h[8] or '0')
local reopen = tonumber(h[9] or '0')
local cooldown = tonumber(h[10] or '0')
if cooldown <= 0 then cooldown = cooldownBase end

local from = state
local wonProbe = false
local wonToken = ''

local function hasPrefix(field, prefix)
  return string.sub(field, 1, string.len(prefix)) == prefix
end

-- Drops every rolling window and failure breakdown field.
local function clearAux()
  local fields = redis.call('HKEYS', key)
  for _, field in ipairs(fields) do
    if hasPrefix(field, 'fr:') or hasPrefix(field, 'wt:') or hasPrefix(field, 'wf:') then
      redis.call('HDEL', key, field)
    end
  end
end

-- Fixed 10 sub bucket rolling window, the same coarse bounded tradeoff
-- core's RollingRatio makes. Returns total calls and failures inside it.
local function windowRecord(failed)
  local width = rollWindow / 10
  local idx = math.floor(now / width)
  redis.call('HINCRBY', key, 'wt:' .. idx, 1)
  if failed then redis.call('HINCRBY', key, 'wf:' .. idx, 1) end

  local total, fails = 0, 0
  local fields = redis.call('HGETALL', key)
  for i = 1, #fields, 2 do
    local field = fields[i]
    local isTotal = hasPrefix(field, 'wt:')
    if isTotal or hasPrefix(field, 'wf:') then
      local fieldIdx = tonumber(string.sub(field, 4))
      if fieldIdx <= idx - 10 then
        redis.call('HDEL', key, field)
      elseif isTotal then
        total = total + tonumber(fields[i + 1])
      else
        fails = fails + tonumber(fields[i + 1])
      end
    end
  end
  return total, fails
end

local function computeCooldown(count)
  if backoffMult <= 0 then return cooldownBase end
  local exp = cooldownBase * (backoffMult ^ count)
  if backoffMax > 0 and exp > backoffMax then exp = backoffMax end
  return math.floor(exp * rand)
end

local function openCircuit()
  state = 'open'
  openedAt = now
  cooldown = computeCooldown(reopen)
  slots = 0
  tsucc = 0
  tfail = 0
end

local function closeCircuit()
  state = 'closed'
  failures = 0
  reopen = 0
  slots = 0
  tsucc = 0
  tfail = 0
  cooldown = cooldownBase
  clearAux()
end

-- Once every admitted trial has reported in, closes or reopens.
local function settleTrial()
  if tsucc + tfail < probes then return end
  if tsucc / probes >= ratioNeeded then
    closeCircuit()
  else
    reopen = reopen + 1
    openCircuit()
  end
end

local function countsAsProbe()
  if token == '*' then return true end
  return token ~= '' and token == tostring(epoch)
end

local function attribute()
  redis.call('HINCRBY', key, 'fr:' .. code, 1)
end

if outcome == 'check' then
  if grant then
    if state == 'open' and (now - openedAt) >= cooldown then
      state = 'half-open'
      epoch = epoch + 1
      slots = probes
      tsucc = 0
      tfail = 0
      grantAt = 0
    end

    if state == 'half-open' then
      -- A holder that vanished without reporting abandons the trial: start
      -- a fresh epoch, which also invalidates every token still out there,
      -- so a slow holder's late outcome can't settle the new trial.
      local outstanding = probes - slots - tsucc - tfail
      if outstanding > 0 and grantAt > 0 and (now - grantAt) >= leaseMs then
        epoch = epoch + 1
        slots = probes
        tsucc = 0
        tfail = 0
      end

      if slots > 0 then
        slots = slots - 1
        grantAt = now
        wonProbe = true
        wonToken = tostring(epoch)
      end
    end
  end
elseif outcome == 'success' then
  if state == 'half-open' then
    if countsAsProbe() then
      tsucc = tsucc + 1
      settleTrial()
    end
  elseif state == 'closed' then
    failures = 0
    if rollWindow > 0 then windowRecord(false) end
  end
  -- 'open': a late success from a call that started before the trip
  -- must not close the circuit.
elseif outcome == 'failure' then
  if state == 'half-open' then
    if countsAsProbe() then
      failures = failures + 1
      tfail = tfail + 1
      attribute()
      settleTrial()
    end
  else
    failures = failures + 1
    attribute()
    if state == 'closed' then
      local trip
      if rollWindow > 0 then
        local total, fails = windowRecord(true)
        trip = total >= rollMin and (fails / total) >= rollRatio
      else
        trip = failures >= threshold
      end
      if trip then openCircuit() end
    end
  end
elseif outcome == 'release' then
  if state == 'half-open' and token ~= '' and token ~= '*' and token == tostring(epoch) then
    if slots + tsucc + tfail < probes then slots = slots + 1 end
  end
elseif outcome == 'open' then
  openCircuit()
elseif outcome == 'close' then
  closeCircuit()
end

redis.call('HSET', key,
  'state', state, 'failures', failures, 'openedAt', openedAt, 'epoch', epoch,
  'slots', slots, 'succ', tsucc, 'tfail', tfail, 'grantAt', grantAt,
  'reopen', reopen, 'cooldown', cooldown)
redis.call('PEXPIRE', key, math.max(math.max(cooldown, cooldownBase) * 4, leaseMs * 2))

if from ~= state then
  -- Structured JSON, not '|'-joined fields: a key containing '|' (an
  -- isolateByModel model name is caller-supplied) would otherwise split
  -- into the wrong number of parts and desync the subscriber's parse.
  local payload = cjson.encode({
    key = key, state = state, failures = failures, openedAt = openedAt,
    now = now, cooldown = cooldown, slots = slots, grantAt = grantAt,
  })
  redis.call('PUBLISH', channel, payload)
end

-- Failure attribution, only read while it can be non empty, so a healthy
-- closed circuit never pays for the extra HGETALL.
local breakdown = ''
if failures > 0 or state ~= 'closed' then
  local parts = {}
  local fields = redis.call('HGETALL', key)
  for i = 1, #fields, 2 do
    if hasPrefix(fields[i], 'fr:') then
      parts[#parts + 1] = string.sub(fields[i], 4) .. '=' .. fields[i + 1]
    end
  end
  breakdown = table.concat(parts, ',')
end

return {
  from, state, tostring(failures), wonProbe and '1' or '0', tostring(openedAt), wonToken, breakdown,
  tostring(now), tostring(cooldown), tostring(grantAt), tostring(slots),
}
`;

export interface TransitionResult {
  from: CircuitState;
  to: CircuitState;
  failures: number;
  /** True only for the single caller, across every process, whose 'check' call actually won a half-open trial slot. See TRANSITION_SCRIPT. */
  wonProbe: boolean;
  /** Redis's own committed openedAt for this bucket, not a client-side reconstruction. */
  openedAt: number;
  /** The half-open epoch this caller's slot belongs to, non empty only when `wonProbe`. Presented back on that call's outcome. */
  probeToken: string;
  /** Failure counts by error code for this bucket, `unknown` for a failure that carried none. */
  breakdown: Record<string, number>;
  /** Redis's clock at the moment of this transition, in ms. */
  serverNow: number;
  /** The cooldown in force for this bucket, in ms. */
  cooldownMs: number;
  /** When the most recent half-open slot was handed out, on Redis's clock, or 0 if none has been. */
  grantAt: number;
  /** Half-open trial slots not yet handed out. */
  slots: number;
}

/** Parses the script's `code=count,code=count` breakdown string. */
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

/** Parses TRANSITION_SCRIPT's raw eval() return value into a typed result. */
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
  ] = raw as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
    string | undefined,
    string,
    string,
    string,
    string,
  ];

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
  };
}

const VALID_CIRCUIT_STATES: ReadonlySet<string> = new Set(['closed', 'open', 'half-open']);

/** What a published transition tells a subscriber. Same fields as a script reply's state, minus the caller specific ones. */
export interface TransitionMessage {
  key: string;
  state: CircuitState;
  failures: number;
  openedAt: number;
  serverNow: number;
  cooldownMs: number;
  slots: number;
  grantAt: number;
}

/** The numeric fields of a published transition, as named in TRANSITION_SCRIPT's `cjson.encode`. */
const NUMERIC_MESSAGE_FIELDS = [
  'failures',
  'openedAt',
  'now',
  'cooldown',
  'slots',
  'grantAt',
] as const;

/**
 * Parses a pub/sub message published by TRANSITION_SCRIPT's own PUBLISH
 * above: a JSON object with the fields in `TransitionMessage`. Returns
 * undefined for anything that isn't valid, well-shaped JSON, malformed
 * input from a channel this adapter doesn't fully control the traffic on
 * should be ignored, not thrown on.
 */
export function parseTransitionMessage(message: string): TransitionMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const { key, state } = record;

  if (typeof key !== 'string' || !key) return undefined;
  if (typeof state !== 'string' || !VALID_CIRCUIT_STATES.has(state)) return undefined;

  const numbers: Record<string, number> = {};
  for (const name of NUMERIC_MESSAGE_FIELDS) {
    const value = record[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    numbers[name] = value;
  }

  return {
    key,
    state: state as CircuitState,
    failures: numbers.failures!,
    openedAt: numbers.openedAt!,
    serverNow: numbers.now!,
    cooldownMs: numbers.cooldown!,
    slots: numbers.slots!,
    grantAt: numbers.grantAt!,
  };
}
