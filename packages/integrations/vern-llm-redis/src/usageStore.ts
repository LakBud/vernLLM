import { toRedisError } from './internal/shared/errors/redisError.utils.js';
import { resolveKeyPrefix } from './internal/shared/errors/validate.utils.js';
import { withScriptCache } from './internal/shared/redis/scriptCache.utils.js';
import {
  parseFour,
  parseReserve,
  READ_SCRIPT,
  RESERVE_SCRIPT,
  SETTLE_SCRIPT,
} from './internal/usage-store/scripts.js';

import type { RedisClient } from './types.js';

/** A spend as integers: nano dollars and whole tokens. */
export interface UsageAmount {
  nanoUsd: number;
  tokens: number;
}

/** One budget on one value in one window, as `vern-llm-usage` hands it over. */
export interface UsageScope {
  key: string;
  label: string;
  unit: 'usd' | 'tokens';
  limit: number;
  resetsAtMs: number;
}

/** The `vern-llm-usage` `UsageStore` shape, declared here so this package never imports it. */
export interface RedisUsageStore {
  /** Holds the amount on every scope, or refuses with the first scope without room. */
  reserve(
    scopes: readonly UsageScope[],
    amount: UsageAmount,
    ttlMs: number,
  ): Promise<{ ok: true; id: string } | { ok: false; scope: UsageScope; remaining: number }>;
  /** Frees a hold and adds the real spend. */
  commit(id: string, actual: UsageAmount): Promise<void>;
  /** Frees a hold without recording spend. */
  release(id: string): Promise<void>;
  /** Spent and reserved on a scope. */
  read(scope: UsageScope): Promise<{ spent: UsageAmount; reserved: UsageAmount }>;
}

export interface RedisUsageStoreOptions {
  /** Key prefix. Stores with the same prefix share budgets. Default "vernllm:usage". */
  keyPrefix?: string;
}

/** How long keys outlive their window or hold, so a late settle or sweep still finds them. */
const GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A Redis `UsageStore` shared by every process with the same prefix. Each operation is one script,
 * so `reserve` holds every scope or none. A Redis error rejects the operation.
 */
export function redisUsageStore(
  client: RedisClient,
  options: RedisUsageStoreOptions = {},
): RedisUsageStore {
  const redis = withScriptCache(client);
  const prefix = `{${resolveKeyPrefix(options.keyPrefix, 'vernllm:usage')}}:`;
  const expKey = `${prefix}exp`;
  /** Key of a scope's hash. */
  const scopeKey = (scope: UsageScope) => `${prefix}s:${scope.key}`;
  /** Key of one hold's hash. */
  const reservationKey = (id: string) => `${prefix}r:${id}`;

  /** Runs a script and parses its reply, so a bad reply is a Redis error too. */
  const run = async <T>(
    operation: string,
    call: () => Promise<unknown>,
    parse: (reply: unknown) => T,
  ) => {
    try {
      return parse(await call());
    } catch (error) {
      throw toRedisError(`usageStore.${operation}`, error);
    }
  };
  /** Parser for scripts whose reply is not used. */
  const ignore = () => undefined;

  return {
    async reserve(scopes, amount, ttlMs) {
      const id = globalThis.crypto.randomUUID();
      const args: (string | number)[] = [
        prefix,
        Math.max(1, Math.ceil(ttlMs)),
        GRACE_MS,
        amount.nanoUsd,
        amount.tokens,
      ];
      for (const scope of scopes) {
        args.push(scope.unit === 'usd' ? 'u' : 't', scope.limit, scope.resetsAtMs);
      }

      const reply = await run(
        'reserve',
        () =>
          redis.eval(
            RESERVE_SCRIPT,
            2 + scopes.length,
            expKey,
            reservationKey(id),
            ...scopes.map(scopeKey),
            ...args,
          ),
        parseReserve,
      );
      if (reply.ok) return { ok: true, id };
      return { ok: false, scope: scopes[reply.index - 1]!, remaining: reply.remaining };
    },

    async commit(id, actual) {
      await run(
        'commit',
        () =>
          redis.eval(
            SETTLE_SCRIPT,
            2,
            expKey,
            reservationKey(id),
            prefix,
            id,
            '1',
            actual.nanoUsd,
            actual.tokens,
          ),
        ignore,
      );
    },

    async release(id) {
      await run(
        'release',
        () => redis.eval(SETTLE_SCRIPT, 2, expKey, reservationKey(id), prefix, id, '0', 0, 0),
        ignore,
      );
    },

    async read(scope) {
      const [su, st, ru, rt] = await run(
        'read',
        () => redis.eval(READ_SCRIPT, 2, expKey, scopeKey(scope), prefix),
        parseFour,
      );
      return { spent: { nanoUsd: su, tokens: st }, reserved: { nanoUsd: ru, tokens: rt } };
    },
  };
}
