import { describe, expect, it, vi } from 'vitest';

import {
  NEAR_INSTANT_MS,
  createMockClient,
  expectNearInstant,
  fakeSubscriber,
  waitUntil,
} from '../../helpers.js';

describe('fakeSubscriber', () => {
  it('ignores a registration for an event other than "message"', () => {
    const subscriber = fakeSubscriber();
    const onMessage = vi.fn();

    // Bypasses the type system deliberately, same reasoning as the
    // equivalent test for fromNodeRedisSubscriber's real 'on' guard:
    // exercises the runtime check a caller that ignores types would hit.
    (subscriber.on as (event: string, listener: typeof onMessage) => unknown)('other', onMessage);

    subscriber.emit('ch', 'hello');

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('expectNearInstant', () => {
  it('does not throw for a duration well under the threshold', () => {
    expect(() => expectNearInstant(0)).not.toThrow();
    expect(() => expectNearInstant(NEAR_INSTANT_MS - 1)).not.toThrow();
  });

  it('throws once the duration reaches the threshold, inclusive', () => {
    expect(() => expectNearInstant(NEAR_INSTANT_MS)).toThrow(/near-instant/);
  });

  it('throws for a duration well past the threshold, with both numbers in the message', () => {
    expect(() => expectNearInstant(NEAR_INSTANT_MS + 250)).toThrow(
      new RegExp(`${NEAR_INSTANT_MS}ms.*${NEAR_INSTANT_MS + 250}ms`),
    );
  });
});

describe('createMockClient', () => {
  it('throws if the client is invoked with an empty script', async () => {
    const { client } = createMockClient([]);

    await expect(
      client.chat.completions.create(
        { model: 'm', max_tokens: 1, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('script is empty');
  });
});

describe('waitUntil', () => {
  it('resolves as soon as the condition becomes true', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 10);

    await expect(waitUntil(() => ready)).resolves.toBeUndefined();
  });

  it('supports an async condition', async () => {
    await expect(waitUntil(async () => true)).resolves.toBeUndefined();
  });

  it('throws once timeoutMs elapses without the condition ever becoming true', async () => {
    await expect(waitUntil(() => false, { timeoutMs: 30, intervalMs: 10 })).rejects.toThrow(
      /condition not met within 30ms/,
    );
  });
});
