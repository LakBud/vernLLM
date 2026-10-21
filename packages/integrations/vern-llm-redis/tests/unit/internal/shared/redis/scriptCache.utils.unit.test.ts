import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { withScriptCache } from '../../../../../src/internal/shared/redis/scriptCache.utils.js';
import { fakeRedisClient } from '../../../../helpers.js';

const SCRIPT = 'return ARGV[1]';
const SHA = createHash('sha1').update(SCRIPT).digest('hex');

function noScript(): Error {
  return new Error('NOSCRIPT No matching script. Please use EVAL.');
}

function clientWithEvalsha() {
  const redis = fakeRedisClient();
  const evalsha =
    vi.fn<(sha: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>>();
  return { redis: Object.assign(redis, { evalsha }), evalsha };
}

describe('withScriptCache', () => {
  it('returns a client without evalsha unchanged', () => {
    const redis = fakeRedisClient();
    expect(withScriptCache(redis)).toBe(redis);
  });

  it('sends the full script once, then only its SHA1', async () => {
    const { redis, evalsha } = clientWithEvalsha();
    redis.eval.mockResolvedValue('a');
    evalsha.mockResolvedValue('b');
    const cached = withScriptCache(redis);

    await expect(cached.eval(SCRIPT, 1, 'k', 'x')).resolves.toBe('a');
    await expect(cached.eval(SCRIPT, 1, 'k', 'y')).resolves.toBe('b');
    await expect(cached.eval(SCRIPT, 1, 'k', 'z')).resolves.toBe('b');

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(evalsha).toHaveBeenCalledTimes(2);
    expect(evalsha).toHaveBeenLastCalledWith(SHA, 1, 'k', 'z');
  });

  it('falls back to EVAL when Redis no longer has the script cached', async () => {
    const { redis, evalsha } = clientWithEvalsha();
    redis.eval.mockResolvedValue('full');
    evalsha.mockRejectedValueOnce(noScript()).mockResolvedValue('hash');
    const cached = withScriptCache(redis);

    await cached.eval(SCRIPT, 0);
    await expect(cached.eval(SCRIPT, 0)).resolves.toBe('full');
    await expect(cached.eval(SCRIPT, 0)).resolves.toBe('hash');

    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('rethrows any other evalsha error without resending the script', async () => {
    const { redis, evalsha } = clientWithEvalsha();
    redis.eval.mockResolvedValue('ok');
    evalsha.mockRejectedValue(new Error('ERR user_script:1: boom'));
    const cached = withScriptCache(redis);

    await cached.eval(SCRIPT, 0);
    await expect(cached.eval(SCRIPT, 0)).rejects.toThrow('boom');
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('keeps sending the full script while EVAL keeps failing', async () => {
    const { redis, evalsha } = clientWithEvalsha();
    redis.eval.mockRejectedValueOnce(new Error('down')).mockResolvedValue('ok');
    const cached = withScriptCache(redis);

    await expect(cached.eval(SCRIPT, 0)).rejects.toThrow('down');
    await cached.eval(SCRIPT, 0);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(evalsha).not.toHaveBeenCalled();
  });

  it('passes get, set, del and scan through to the client', async () => {
    const { redis } = clientWithEvalsha();
    const cached = withScriptCache(redis);

    await cached.get('k');
    await cached.set('k', 'v', 'PX', 5);
    await cached.del('a', 'b');
    await cached.scan!('0', 'MATCH', 'p:*', 'COUNT', 10);

    expect(redis.get).toHaveBeenCalledWith('k');
    expect(redis.set).toHaveBeenCalledWith('k', 'v', 'PX', 5);
    expect(redis.del).toHaveBeenCalledWith('a', 'b');
    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'p:*', 'COUNT', 10);
  });

  it('exposes evalsha, forwarded to the client', async () => {
    const { redis, evalsha } = clientWithEvalsha();
    evalsha.mockResolvedValue('r');

    await expect(withScriptCache(redis).evalsha!('abc', 1, 'k')).resolves.toBe('r');
    expect(evalsha).toHaveBeenCalledWith('abc', 1, 'k');
  });

  it('leaves scan undefined for a client without it', () => {
    const { redis } = clientWithEvalsha();
    delete (redis as { scan?: unknown }).scan;
    expect(withScriptCache(redis).scan).toBeUndefined();
  });
});
