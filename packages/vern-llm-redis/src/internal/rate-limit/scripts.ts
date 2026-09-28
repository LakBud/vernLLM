/** Scripts read time from Redis (`TIME`), so one process's skewed clock can't distort a shared bucket. */
const SERVER_NOW = `
if redis.replicate_commands then redis.replicate_commands() end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** A per minute bucket's ceiling: KEYS[2] with AIMD, else `initCap`. */
const READ_CAP = `
local cap = initCap
if KEYS[2] then cap = tonumber(redis.call('HGET', KEYS[2], 'cap')) or initCap end
`;

/** Takes `amount` from a per minute bucket. KEYS: bucket, ceiling key if any. ARGV: initialCapacity, amount. */
export const TAKE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local initCap = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
${READ_CAP}

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

redis.call('HSET', key, 'avail', avail, 'last', last)
redis.call('PEXPIRE', key, 120000)

return { ok, tostring(avail), tostring(cap), tostring(waitMs) }
`;

/** Gives `amount` back, capped at the ceiling. KEYS and ARGV as TAKE_SCRIPT. */
export const GIVE_SCRIPT = `
local key = KEYS[1]
local initCap = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
${READ_CAP}

local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end

avail = math.min(cap, avail + amount)
redis.call('HSET', key, 'avail', avail)
redis.call('PEXPIRE', key, 120000)

return tostring(avail)
`;

/** Takes a concurrency lease, a sorted set member that lapses unless renewed. ARGV: capacity, leaseId, leaseMs. */
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
-- The newest lease has the latest expiry, so the key can go with it.
redis.call('PEXPIRE', key, leaseMs)

return { 1, tostring(cap - used - 1), tostring(cap), '-1' }
`;

/** Renews a live lease. Returns 1, or 0 if it was gone. ARGV: leaseId, leaseMs. */
export const RENEW_LEASE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local leaseId = ARGV[1]
local leaseMs = tonumber(ARGV[2])

if not redis.call('ZSCORE', key, leaseId) then return 0 end

redis.call('ZADD', key, now + leaseMs, leaseId)
redis.call('PEXPIRE', key, leaseMs)
return 1
`;

/** Ends a lease and wakes waiters. ARGV: leaseId, channel. */
export const GIVE_LEASE_SCRIPT = `
local key = KEYS[1]
local leaseId = ARGV[1]
local channel = ARGV[2]

redis.call('ZREM', key, leaseId)
redis.call('PUBLISH', channel, key)

return redis.call('ZCARD', key)
`;

/**
 * The shared FIFO line: one hash of leased tickets. ARGV: op, id, leaseMs,
 * channel, maxSize. Ops: peek, enter (refused when full), check (renews,
 * rejoins if lapsed), leave. Returns { isHead, depth, full }.
 */
export const QUEUE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local op = ARGV[1]
local id = ARGV[2]
local leaseMs = tonumber(ARGV[3])
local channel = ARGV[4]
local maxSize = tonumber(ARGV[5] or '0')
local mine = 'w:' .. id
local full = 0

-- Live waiters, lapsed ones pruned.
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
elseif op == 'enter' and not existed and maxSize > 0 and #live >= maxSize then
  -- An admitted waiter that lapsed rejoins through 'check', never refused.
  full = 1
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

-- Only the counter left: nobody waits.
if redis.call('HLEN', key) <= 1 then
  redis.call('DEL', key)
else
  redis.call('PEXPIRE', key, leaseMs * 2)
end

-- The head may have left: wake the line.
if pruned then redis.call('PUBLISH', channel, key) end

local first = head()
local depth = #live
if op == 'leave' then
  depth = math.max(0, depth - (existed and 1 or 0))
  first = nil
end
return { (first ~= nil and first[1] == mine) and 1 or 0, depth, full }
`;

/** Parses QUEUE_SCRIPT's `{ isHead, depth, full }` reply. */
export function parseQueueResult(raw: unknown): { isHead: boolean; depth: number; full: boolean } {
  const [isHead, depth, full] = raw as [number, number, number | undefined];
  return { isHead: isHead === 1, depth: Number(depth), full: full === 1 };
}

/**
 * AIMD resize: add on 'grow', multiply on 'shrink', at most one shrink per
 * shrinkWindowMs across processes. KEYS: bucket, ceiling key. ARGV: op,
 * amount, minCapacity, maxCapacity, initialCapacity, shrinkWindowMs.
 */
export const RESIZE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local op = ARGV[1]
local amount = tonumber(ARGV[2])
local minCap = tonumber(ARGV[3])
local maxCap = tonumber(ARGV[4])
local initCap = tonumber(ARGV[5])
local shrinkWindowMs = tonumber(ARGV[6])
${READ_CAP}

if op == 'grow' then
  cap = math.min(cap + amount, maxCap)
else
  local shrunkAt = tonumber(redis.call('HGET', KEYS[2], 'shrunkAt'))
  if shrunkAt and now >= shrunkAt and now - shrunkAt < shrinkWindowMs then
    return tostring(cap)
  end
  redis.call('HSET', KEYS[2], 'shrunkAt', now)
  cap = math.max(cap * amount, minCap)
end

local avail = tonumber(redis.call('HGET', key, 'avail'))
if not avail then avail = cap end
avail = math.min(avail, cap)

redis.call('HSET', KEYS[2], 'cap', cap)
redis.call('HSET', key, 'avail', avail)
redis.call('PEXPIRE', key, 120000)

return tostring(cap)
`;

/** Reads one bucket without writing. ARGV: mode, initialCapacity. Returns { avail, cap }. */
export const STATE_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local mode = ARGV[1]
local initCap = tonumber(ARGV[2])

if mode == 'lease' then
  local live = redis.call('ZCOUNT', key, '(' .. now, '+inf')
  return { tostring(math.max(0, initCap - live)), tostring(initCap) }
end

${READ_CAP}
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
  /** Ms until the amount is available, or -1 for a concurrency bucket. */
  waitMs: number;
}

/** Parses a TAKE_SCRIPT or TAKE_LEASE_SCRIPT reply. */
export function parseTakeResult(raw: unknown): TakeResult {
  const [ok, avail, cap, waitMs] = raw as [number, string, string, string];
  return { ok: ok === 1, avail: Number(avail), cap: Number(cap), waitMs: Number(waitMs) };
}

/** Parses STATE_SCRIPT's `{ avail, cap }` reply. */
export function parseStateResult(raw: unknown): { avail: number; cap: number } {
  const [avail, cap] = raw as [string, string];
  return { avail: Number(avail), cap: Number(cap) };
}
