/**
 * Atomic token-bucket take. The ceiling (cap) lives in Redis, not just
 * the caller's config, so AIMD growth/shrink from any process is
 * respected by every process reading this key. rateMode 'permin' derives
 * the refill rate from the live cap (cap / 60000); '0' means no time
 * based refill at all (concurrency). On a miss, also returns how many ms
 * until this bucket could supply amount on its own (-1 for a
 * concurrency bucket, which never refills on its own).
 */
export const TAKE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local initCap = tonumber(ARGV[2])
local rateMode = ARGV[3]
local amount = tonumber(ARGV[4])

local cap = tonumber(redis.call('HGET', key, 'cap'))
if not cap then cap = initCap end

local ratePerMs = 0
if rateMode == 'permin' then
  ratePerMs = cap / 60000
end

local last = tonumber(redis.call('HGET', key, 'last'))
if not last then last = now end
local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end

local elapsed = now - last
if elapsed > 0 and ratePerMs > 0 then
  avail = math.min(cap, avail + elapsed * ratePerMs)
  last = now
end

local ok = 0
local waitMs = -1
if avail >= amount then
  avail = avail - amount
  ok = 1
elseif ratePerMs > 0 then
  waitMs = (amount - avail) / ratePerMs
end

redis.call('HSET', key, 'cap', cap, 'avail', avail, 'last', last)

-- A concurrency bucket (rateMode '0') has no time-based refill: 'avail'
-- only ever changes via an explicit take/give. If it's allowed to expire
-- while slots are actively held (avail < cap), a later take on this key
-- recreates a fresh, fully-available bucket, silently losing track of
-- outstanding leases and letting concurrency exceed maxConcurrent. So a
-- concurrency bucket with outstanding leases is persisted (no expiry)
-- instead, and only put back on a TTL once every lease has been given
-- back and it's genuinely idle.
if rateMode == '0' and avail < cap then
  redis.call('PERSIST', key)
else
  redis.call('PEXPIRE', key, 120000)
end

return { ok, tostring(avail), tostring(cap), tostring(waitMs) }
`;

/** Gives amount back to a bucket, capped at its live Redis cap, and publishes a wake for anyone waiting on this key. */
export const GIVE_SCRIPT = `
local key = KEYS[1]
local initCap = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local channel = ARGV[3]
local rateMode = ARGV[4]

local cap = tonumber(redis.call('HGET', key, 'cap'))
if not cap then cap = initCap end

local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end

avail = math.min(cap, avail + amount)
redis.call('HSET', key, 'avail', avail)

-- Mirrors TAKE_SCRIPT's reasoning: once every lease on a concurrency
-- bucket has been returned (avail caught back up to cap), it's safe to
-- let the key expire again; until then it must be kept alive.
if rateMode == '0' and avail < cap then
  redis.call('PERSIST', key)
else
  redis.call('PEXPIRE', key, 120000)
end

redis.call('PUBLISH', channel, key)

return tostring(avail)
`;

/** Atomically resizes the requests-per-minute cap: additive-increase on 'grow', multiplicative-decrease otherwise, then clamps avail down to the new cap if it shrank. */
export const RESIZE_SCRIPT = `
local key = KEYS[1]
local op = ARGV[1]
local amount = tonumber(ARGV[2])
local minCap = tonumber(ARGV[3])
local maxCap = tonumber(ARGV[4])
local initCap = tonumber(ARGV[5])

local cap = tonumber(redis.call('HGET', key, 'cap'))
if not cap then cap = initCap end

if op == 'grow' then
  cap = math.min(cap + amount, maxCap)
else
  cap = math.max(cap * amount, minCap)
end

local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end
avail = math.min(avail, cap)

redis.call('HSET', key, 'cap', cap, 'avail', avail)
redis.call('PEXPIRE', key, 120000)

return tostring(cap)
`;

export interface TakeResult {
  ok: boolean;
  avail: number;
  cap: number;
  /** Ms until this bucket could supply the requested amount, or -1 for a bucket with no deterministic refill (concurrency). */
  waitMs: number;
}

/** Parses TAKE_SCRIPT's raw eval() return value into a typed result. */
export function parseTakeResult(raw: unknown): TakeResult {
  const [ok, avail, cap, waitMs] = raw as [number, string, string, string];
  return { ok: ok === 1, avail: Number(avail), cap: Number(cap), waitMs: Number(waitMs) };
}
