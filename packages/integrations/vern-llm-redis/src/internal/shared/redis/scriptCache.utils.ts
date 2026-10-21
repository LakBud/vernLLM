import type { RedisClient } from '../../../types.js';

/** Hex SHA1 of `script`. */
async function sha1(script: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(script));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Redis's reply for a script it has not cached. */
function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

/** Sends each script once with EVAL, then by SHA1, resending on NOSCRIPT. Clients without `evalsha` are returned as is. */
export function withScriptCache(redis: RedisClient): RedisClient {
  if (!redis.evalsha) return redis;

  /** SHA1 per script Redis has run. */
  const loaded = new Map<string, string>();

  async function evalAndMark(
    script: string,
    numKeys: number,
    args: (string | number)[],
  ): Promise<unknown> {
    // Hashed alongside the EVAL, so later calls never wait on the digest.
    const [result, sha] = await Promise.all([redis.eval(script, numKeys, ...args), sha1(script)]);
    loaded.set(script, sha);
    return result;
  }

  // Looked up per call, so a later wrapper or spy sees every call.
  return {
    get: (key) => redis.get(key),
    set: (key, value, mode, durationMs) => redis.set(key, value, mode, durationMs),
    del: (...keys) => redis.del(...keys),
    scan: redis.scan && ((...args) => redis.scan!(...args)),
    evalsha: (sha, numKeys, ...args) => redis.evalsha!(sha, numKeys, ...args),

    async eval(script, numKeys, ...args) {
      const sha = loaded.get(script);
      if (sha === undefined) return evalAndMark(script, numKeys, args);

      try {
        return await redis.evalsha!(sha, numKeys, ...args);
      } catch (error) {
        // Only a cache miss is worth resending the source for.
        if (!isNoScript(error)) throw error;
        return evalAndMark(script, numKeys, args);
      }
    },
  };
}
