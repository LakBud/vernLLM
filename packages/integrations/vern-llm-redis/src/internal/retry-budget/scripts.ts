/**
 * Scripts read time from Redis (`TIME`), so one process's skewed clock can't shift a shared window.
 * The window is 10 sub buckets, like core's `RollingRatio`: `wt:<idx>` counts attempts and
 * `wr:<idx>` retries, where `idx = floor(now / bucketWidthMs)`.
 */
const SERVER_NOW = `
if redis.replicate_commands then redis.replicate_commands() end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** Sums the live buckets into `total` and `retries`, deleting aged out ones. */
const SUM_WINDOW = `
local function sumWindow(idx)
  local total, retries = 0, 0
  local fields = redis.call('HGETALL', key)
  for i = 1, #fields, 2 do
    local field = fields[i]
    local kind = string.sub(field, 1, 3)
    if kind == 'wt:' or kind == 'wr:' then
      local fieldIdx = tonumber(string.sub(field, 4))
      if fieldIdx <= idx - 10 then
        redis.call('HDEL', key, field)
      elseif kind == 'wt:' then
        total = total + tonumber(fields[i + 1])
      else
        retries = retries + tonumber(fields[i + 1])
      end
    end
  end
  return total, retries
end
`;

/** Counts one attempt, then returns the window. KEYS: budget. ARGV: bucketWidthMs, isRetry (1 or 0), ttlMs. */
export const RECORD_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local width = tonumber(ARGV[1])
local isRetry = ARGV[2] == '1'
local ttl = tonumber(ARGV[3])
${SUM_WINDOW}
local idx = math.floor(now / width)
redis.call('HINCRBY', key, 'wt:' .. idx, 1)
if isRetry then redis.call('HINCRBY', key, 'wr:' .. idx, 1) end

local total, retries = sumWindow(idx)
redis.call('PEXPIRE', key, ttl)
return { total, retries }
`;

/** Returns the window without counting an attempt. KEYS: budget. ARGV: bucketWidthMs. */
export const READ_SCRIPT = `${SERVER_NOW}
local key = KEYS[1]
local width = tonumber(ARGV[1])
${SUM_WINDOW}
local total, retries = sumWindow(math.floor(now / width))
return { total, retries }
`;

/** Attempts and retries in the window, as a script returns them. */
export interface WindowCounts {
  attempts: number;
  retries: number;
}

/** Reads a script's `{ total, retries }` reply. Anything else is a protocol mismatch and throws. */
export function parseWindowReply(reply: unknown): WindowCounts {
  if (Array.isArray(reply) && reply.length === 2) {
    const attempts = Number(reply[0]);
    const retries = Number(reply[1]);
    if (Number.isInteger(attempts) && Number.isInteger(retries) && retries <= attempts) {
      return { attempts, retries };
    }
  }

  throw new Error(`Unexpected retry budget script reply: ${JSON.stringify(reply)}`);
}
