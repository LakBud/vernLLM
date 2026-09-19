/**
 * Every script here reads time from Redis (`TIME`), never from a caller.
 * Bucket refill is derived from the gap between two timestamps, so with a
 * shared key one process's skewed clock would otherwise refill a bucket
 * instantly, or push `last` into the future and stop every correct clock
 * from refilling it at all.
 */
const SERVER_NOW = `
if redis.replicate_commands then redis.replicate_commands() end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/**
 * Atomic token-bucket take for the requests/min and tokens/min buckets.
 * The ceiling (cap) lives in Redis, not just the caller's config, so AIMD
 * growth/shrink from any process is respected by every process reading
 * this key. The refill rate is derived from the live cap (cap / 60000).
 * On a miss, also returns how many ms until this bucket could supply
 * amount on its own.
 *
 * ARGV: initialCapacity, amount.
 */
export const TAKE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local initCap = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])

local cap = tonumber(redis.call('HGET', key, 'cap'))
if not cap then cap = initCap end

local ratePerMs = cap / 60000

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
redis.call('PEXPIRE', key, 120000)

return { ok, tostring(avail), tostring(cap), tostring(waitMs) }
`;

/** Gives amount back to a requests/min or tokens/min bucket, capped at its live Redis cap. ARGV: initialCapacity, amount. */
export const GIVE_SCRIPT = `
local key = KEYS[1]
local initCap = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])

local cap = tonumber(redis.call('HGET', key, 'cap'))
if not cap then cap = initCap end

local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end

avail = math.min(cap, avail + amount)
redis.call('HSET', key, 'avail', avail)
redis.call('PEXPIRE', key, 120000)

return tostring(avail)
`;

/**
 * Concurrency is a set of leases (a sorted set of lease id to expiry),
 * not a counter. A counter cannot tell a slot that is still in use from
 * one whose holder crashed, so a single lost release would shrink
 * maxConcurrent for good. A lease that stops being renewed simply expires
 * and stops counting, with no cleanup step that can itself be lost.
 *
 * ARGV: capacity, leaseId, leaseMs. Same reply shape as TAKE_SCRIPT.
 */
export const TAKE_LEASE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local leaseId = ARGV[2]
local leaseMs = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local used = redis.call('ZCARD', key)

if used >= cap then
  return { 0, tostring(cap - used), tostring(cap), '-1' }
end

redis.call('ZADD', key, now + leaseMs, leaseId)
-- The newest lease always carries the latest expiry, so the whole key can
-- safely go with it.
redis.call('PEXPIRE', key, leaseMs)

return { 1, tostring(cap - used - 1), tostring(cap), '-1' }
`;

/** Pushes a live lease's expiry forward. Returns 1 if it was renewed, 0 if it was already gone. ARGV: leaseId, leaseMs. */
export const RENEW_LEASE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local leaseId = ARGV[1]
local leaseMs = tonumber(ARGV[2])

if not redis.call('ZSCORE', key, leaseId) then return 0 end

redis.call('ZADD', key, now + leaseMs, leaseId)
redis.call('PEXPIRE', key, leaseMs)
return 1
`;

/** Ends a lease and wakes anyone waiting on this key. ARGV: leaseId, channel. */
export const GIVE_LEASE_SCRIPT = `
local key = KEYS[1]
local leaseId = ARGV[1]
local channel = ARGV[2]

redis.call('ZREM', key, leaseId)
redis.call('PUBLISH', channel, key)

return redis.call('ZCARD', key)
`;

/**
 * One FIFO line of waiters, shared by every process using this limiter, so
 * capacity goes to whoever has waited longest instead of whoever's poll
 * happens to fire first. The whole line is one hash (one key, so it works
 * in cluster mode): a `next` ticket counter plus one `w:<id>` field per
 * waiter holding "ticket:expiry".
 *
 * A waiter that dies leaves its field behind, so every field carries a
 * lease that each `check` renews, and any op prunes the lapsed ones and
 * wakes the line so the next waiter takes over. ARGV: op, id, leaseMs,
 * channel. Ops:
 *   peek   how many live waiters there are (a newcomer joins only if > 0)
 *   enter  take the next ticket, no-op if already in line
 *   check  renew this waiter's lease and say whether it is at the head
 *   leave  drop this waiter and wake the next one
 * Returns { isHead (1/0), depth }.
 */
export const QUEUE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local op = ARGV[1]
local id = ARGV[2]
local leaseMs = tonumber(ARGV[3])
local channel = ARGV[4]
local mine = 'w:' .. id

-- Live waiters as { field, ticket }, lapsed ones removed on the way.
local live = {}
local pruned = false
local fields = redis.call('HGETALL', key)
for i = 1, #fields, 2 do
  local field = fields[i]
  if string.sub(field, 1, 2) == 'w:' then
    local sep = string.find(fields[i + 1], ':', 1, true)
    local ticket = tonumber(string.sub(fields[i + 1], 1, sep - 1))
    local expiry = tonumber(string.sub(fields[i + 1], sep + 1))
    if expiry <= now then
      redis.call('HDEL', key, field)
      pruned = true
    else
      live[#live + 1] = { field, ticket }
    end
  end
end

local function isLive(field)
  for _, entry in ipairs(live) do if entry[1] == field then return true end end
  return false
end

local function head()
  local best = nil
  for _, entry in ipairs(live) do
    if best == nil or entry[2] < best[2] then best = entry end
  end
  return best
end

local existed = isLive(mine)

if op == 'leave' then
  if existed then
    redis.call('HDEL', key, mine)
    pruned = true
  end
elseif op == 'enter' or op == 'check' then
  if not existed then
    local ticket = redis.call('HINCRBY', key, 'next', 1)
    redis.call('HSET', key, mine, ticket .. ':' .. (now + leaseMs))
    live[#live + 1] = { mine, ticket }
  elseif op == 'check' then
    for _, entry in ipairs(live) do
      if entry[1] == mine then
        redis.call('HSET', key, mine, entry[2] .. ':' .. (now + leaseMs))
      end
    end
  end
end

-- Only the counter left means nobody is waiting: let the key go.
if redis.call('HLEN', key) <= 1 then
  redis.call('DEL', key)
else
  redis.call('PEXPIRE', key, leaseMs * 2)
end

-- A lapsed or departed waiter may have been the head: wake the line.
if pruned then redis.call('PUBLISH', channel, key) end

local first = head()
local depth = #live
if op == 'leave' then
  depth = math.max(0, depth - (existed and 1 or 0))
  first = nil
end
return { (first ~= nil and first[1] == mine) and 1 or 0, depth }
`;

/** Parses QUEUE_SCRIPT's `{ isHead, depth }` reply. */
export function parseQueueResult(raw: unknown): { isHead: boolean; depth: number } {
  const [isHead, depth] = raw as [number, number];
  return { isHead: isHead === 1, depth: Number(depth) };
}

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

/**
 * Read only view of one bucket for `readState`, refill included but
 * nothing written back. ARGV: mode ('permin' or 'lease'), initialCapacity.
 * Returns { avail, cap }; for a lease bucket `avail` is the free slots.
 */
export const STATE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local mode = ARGV[1]
local initCap = tonumber(ARGV[2])

if mode == 'lease' then
  local live = redis.call('ZCOUNT', key, '(' .. now, '+inf')
  return { tostring(math.max(0, initCap - live)), tostring(initCap) }
end

local cap = tonumber(redis.call('HGET', key, 'cap'))
if not cap then cap = initCap end
local last = tonumber(redis.call('HGET', key, 'last'))
local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end

if last and now > last then
  avail = math.min(cap, avail + (now - last) * (cap / 60000))
end

return { tostring(avail), tostring(cap) }
`;

export interface TakeResult {
  ok: boolean;
  avail: number;
  cap: number;
  /** Ms until this bucket could supply the requested amount, or -1 for a bucket with no deterministic refill (concurrency). */
  waitMs: number;
}

/** Parses TAKE_SCRIPT's (or TAKE_LEASE_SCRIPT's) raw eval() return value into a typed result. */
export function parseTakeResult(raw: unknown): TakeResult {
  const [ok, avail, cap, waitMs] = raw as [number, string, string, string];
  return { ok: ok === 1, avail: Number(avail), cap: Number(cap), waitMs: Number(waitMs) };
}

/** Parses STATE_SCRIPT's `{ avail, cap }` reply. */
export function parseStateResult(raw: unknown): { avail: number; cap: number } {
  const [avail, cap] = raw as [string, string];
  return { avail: Number(avail), cap: Number(cap) };
}
