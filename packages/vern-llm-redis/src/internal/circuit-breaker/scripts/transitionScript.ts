/**
 * Reads, transitions and writes one circuit atomically, publishing real
 * changes on `channel`. ARGV: outcome, channel, threshold, cooldownMs,
 * leaseMs, token, grant, probes, successRatio, backoffMultiplier,
 * backoffMaxMs, rand, rollingWindowMs, rollingMinCalls, rollingFailureRatio,
 * code. See the circuit breaker docs for how trials, leases and versions work.
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
  'state', 'failures', 'openedAt', 'epoch', 'slots', 'succ', 'tfail', 'grantAt', 'reopen', 'cooldown',
  'ver')
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
local ver = tonumber(h[11] or '0')
if ver <= 0 then ver = now end

local from = state
local wonProbe = false
local wonToken = ''

local function hasPrefix(field, prefix)
  return string.sub(field, 1, string.len(prefix)) == prefix
end

-- Drops the rolling window and breakdown fields.
local function clearAux()
  local fields = redis.call('HKEYS', key)
  for _, field in ipairs(fields) do
    if hasPrefix(field, 'fr:') or hasPrefix(field, 'wt:') or hasPrefix(field, 'wf:') then
      redis.call('HDEL', key, field)
    end
  end
end

-- 10 sub bucket rolling window, like core's. Returns calls and failures.
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

-- Core's formula: jitter only spreads growth above the base.
local function computeCooldown(count)
  if backoffMult <= 0 then return cooldownBase end
  local maxMs = math.huge
  if backoffMax > 0 then maxMs = backoffMax end
  local floor = math.min(cooldownBase, maxMs)
  local exp = math.min(cooldownBase * (backoffMult ^ count), maxMs)
  local upper = floor
  if exp > floor then upper = exp end
  return floor + math.floor((upper - floor) * rand)
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

-- Closes or reopens once every trial has reported.
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
      -- A silent holder abandons the trial: a new epoch voids every old token.
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
  -- A late success from before the trip must not close it.
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
elseif outcome == 'renew' then
  -- Restarts the lease from now. A dead token renews nothing.
  if state == 'half-open' and token ~= '' and token ~= '*' and token == tostring(epoch) then
    grantAt = now
  end
elseif outcome == 'open' then
  openCircuit()
elseif outcome == 'close' then
  closeCircuit()
end

if from ~= state then ver = math.max(ver + 1, now) end

redis.call('HSET', key,
  'state', state, 'failures', failures, 'openedAt', openedAt, 'epoch', epoch,
  'slots', slots, 'succ', tsucc, 'tfail', tfail, 'grantAt', grantAt,
  'reopen', reopen, 'cooldown', cooldown, 'ver', ver)
redis.call('PEXPIRE', key, math.max(math.max(cooldown, cooldownBase) * 4, leaseMs * 2))

if from ~= state then
  -- JSON, since a model name may contain any separator.
  local payload = cjson.encode({
    key = key, from = from, state = state, failures = failures, openedAt = openedAt,
    now = now, cooldown = cooldown, slots = slots, grantAt = grantAt, ver = ver,
    epoch = epoch,
  })
  redis.call('PUBLISH', channel, payload)
end

-- Only read while it can be non empty.
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
  tostring(now), tostring(cooldown), tostring(grantAt), tostring(slots), tostring(ver),
  tostring(epoch),
}
`;
