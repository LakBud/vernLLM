/**
 * Time comes from Redis `TIME`. Keys share one `{prefix}` hash tag:
 * - `s:<scope>`: `su`, `st` spent and `ru`, `rt` reserved (nano dollars, tokens).
 * - `r:<id>`: `u`, `t` held, `n` scope count, `s1`..`sn` scope keys, `x` once expired.
 * - `exp`: sorted set of hold ids by expiry, swept lazily by the next script.
 *
 * ARGV[1] of every script is `{prefix}:`.
 */
const SERVER_NOW = `
if redis.replicate_commands then redis.replicate_commands() end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** How long an expired hold is kept for a late settle. */
const LATE_MS = 60 * 60 * 1000;

/** Frees every expired hold, 100 at a time, keeping each marked `x` for `LATE_MS`. Needs `prefix`, `now`, `expKey`. */
const SWEEP = `
local function unhold(rkey)
  local held = redis.call('HMGET', rkey, 'u', 't', 'n')
  if not held[3] then return end
  local u, tk = tonumber(held[1]), tonumber(held[2])
  for i = 1, tonumber(held[3]) do
    local skey = redis.call('HGET', rkey, 's' .. i)
    if skey and redis.call('EXISTS', skey) == 1 then
      local r = redis.call('HMGET', skey, 'ru', 'rt')
      redis.call('HSET', skey, 'ru', math.max(0, (tonumber(r[1]) or 0) - u), 'rt', math.max(0, (tonumber(r[2]) or 0) - tk))
    end
  end
end

local function sweep()
  local ids
  repeat
    ids = redis.call('ZRANGEBYSCORE', expKey, '-inf', now, 'LIMIT', 0, 100)
    for _, id in ipairs(ids) do
      local rkey = prefix .. 'r:' .. id
      unhold(rkey)
      if redis.call('EXISTS', rkey) == 1 then
        redis.call('HSET', rkey, 'x', 1)
        redis.call('PEXPIRE', rkey, ${LATE_MS})
      end
      redis.call('ZREM', expKey, id)
    end
  until #ids < 100
end
`;

/**
 * Holds an amount on every scope or none. KEYS: exp, hold, scopes... ARGV: prefix, ttlMs, graceMs,
 * nanoUsd, tokens, then per scope unit ('u'|'t'), limit, resetsAtMs.
 * Returns `{1}`, or `{0, scopeIndex, remaining}` for the first scope without room.
 */
export const RESERVE_SCRIPT = `${SERVER_NOW}
local expKey, rkey = KEYS[1], KEYS[2]
local prefix = ARGV[1]
local ttl, grace = tonumber(ARGV[2]), tonumber(ARGV[3])
local nanoUsd, tokens = tonumber(ARGV[4]), tonumber(ARGV[5])
local count = #KEYS - 2
${SWEEP}
sweep()

for i = 1, count do
  local skey = KEYS[2 + i]
  local base = 5 + (i - 1) * 3
  local unit, limit = ARGV[base + 1], tonumber(ARGV[base + 2])
  local v = redis.call('HMGET', skey, unit == 'u' and 'su' or 'st', unit == 'u' and 'ru' or 'rt')
  local used = (tonumber(v[1]) or 0) + (tonumber(v[2]) or 0)
  local amount = unit == 'u' and nanoUsd or tokens
  if used + amount > limit then
    return { 0, i, math.max(0, limit - used) }
  end
end

redis.call('HSET', rkey, 'u', nanoUsd, 't', tokens, 'n', count)
for i = 1, count do
  local skey = KEYS[2 + i]
  local resetsAt = tonumber(ARGV[5 + (i - 1) * 3 + 3])
  redis.call('HINCRBY', skey, 'ru', nanoUsd)
  redis.call('HINCRBY', skey, 'rt', tokens)
  redis.call('PEXPIREAT', skey, resetsAt + grace)
  redis.call('HSET', rkey, 's' .. i, skey)
end
redis.call('PEXPIRE', rkey, ttl + grace)
redis.call('ZADD', expKey, now + ttl, string.sub(rkey, #prefix + 3))
return { 1 }
`;

/**
 * Frees a hold and, for a commit, adds the real spend, even after the hold expired.
 * KEYS: exp, hold. ARGV: prefix, id, record ('1' to add spend), nanoUsd, tokens.
 * Does nothing for a hold already settled or forgotten.
 */
export const SETTLE_SCRIPT = `${SERVER_NOW}
local expKey, rkey = KEYS[1], KEYS[2]
local prefix, id = ARGV[1], ARGV[2]
local record = ARGV[3] == '1'
local nanoUsd, tokens = tonumber(ARGV[4]), tonumber(ARGV[5])
${SWEEP}
sweep()

local held = redis.call('HMGET', rkey, 'u', 't', 'n')
if not held[3] then return 0 end
if redis.call('HEXISTS', rkey, 'x') == 0 then unhold(rkey) end
if record then
  for i = 1, tonumber(held[3]) do
    local skey = redis.call('HGET', rkey, 's' .. i)
    if skey and redis.call('EXISTS', skey) == 1 then
      redis.call('HINCRBY', skey, 'su', nanoUsd)
      redis.call('HINCRBY', skey, 'st', tokens)
    end
  end
end
redis.call('DEL', rkey)
redis.call('ZREM', expKey, id)
return 1
`;

/** Reads a scope. KEYS: exp, scope. ARGV: prefix. Returns spent and reserved, nano dollars then tokens. */
export const READ_SCRIPT = `${SERVER_NOW}
local expKey, skey = KEYS[1], KEYS[2]
local prefix = ARGV[1]
${SWEEP}
sweep()

local v = redis.call('HMGET', skey, 'su', 'st', 'ru', 'rt')
return { tonumber(v[1]) or 0, tonumber(v[2]) or 0, tonumber(v[3]) or 0, tonumber(v[4]) or 0 }
`;

/** A reply of four whole numbers, else a throw. */
export function parseFour(reply: unknown): [number, number, number, number] {
  if (Array.isArray(reply) && reply.length === 4) {
    const numbers = reply.map(Number);
    if (numbers.every((n) => Number.isSafeInteger(n) && n >= 0)) {
      return numbers as [number, number, number, number];
    }
  }
  throw new Error(`Unexpected usage store script reply: ${JSON.stringify(reply)}`);
}

/** The reply of `RESERVE_SCRIPT`. */
export type ReserveReply = { ok: true } | { ok: false; index: number; remaining: number };

/** Reads a `RESERVE_SCRIPT` reply, else a throw. */
export function parseReserve(reply: unknown): ReserveReply {
  if (Array.isArray(reply) && reply.length >= 1) {
    if (Number(reply[0]) === 1) return { ok: true };
    const index = Number(reply[1]);
    const remaining = Number(reply[2]);
    if (
      Number(reply[0]) === 0 &&
      reply.length === 3 &&
      Number.isInteger(index) &&
      index >= 1 &&
      Number.isSafeInteger(remaining) &&
      remaining >= 0
    ) {
      return { ok: false, index, remaining };
    }
  }
  throw new Error(`Unexpected usage store script reply: ${JSON.stringify(reply)}`);
}
