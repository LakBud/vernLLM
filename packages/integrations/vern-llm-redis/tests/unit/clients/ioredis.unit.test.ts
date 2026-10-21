import { describe, expect, it, vi } from 'vitest';

import { fromIoredis, fromIoredisSubscriber } from '../../../src/clients/ioredis.js';

describe('fromIoredis', () => {
  it('returns the same client instance, since ioredis already matches RedisClient', () => {
    const client = { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn() };
    expect(fromIoredis(client)).toBe(client);
  });
});

describe('fromIoredisSubscriber', () => {
  it('returns the same client instance, since ioredis already matches RedisSubscriber', () => {
    const client = { subscribe: vi.fn(), on: vi.fn() };
    expect(fromIoredisSubscriber(client)).toBe(client);
  });
});
