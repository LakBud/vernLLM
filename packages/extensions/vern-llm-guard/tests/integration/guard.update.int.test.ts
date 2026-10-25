import { isLLMError } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import {
  keywords,
  patterns,
  type Check,
  type Detector,
  type GuardResult,
} from '../../src/index.js';
import { createStreamClient, harness, lastUserText, textDeltas } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const code = (error: unknown) => (isLLMError(error) ? error.code : undefined);
const results = (events: { name: string; data: unknown }[]) =>
  events.filter((event) => event.name === 'guard.result').map((e) => e.data as GuardResult);

const leak = (word: string): Check => ({
  id: 'leak',
  detect: keywords([word]),
  action: 'block',
  on: 'output',
});

describe('update', () => {
  it('applies the new checks to the next call, under the new version', async () => {
    const { llm, guard, events } = harness(
      { checks: [] },
      {},
      { primary: () => 'the password is hunter2' },
    );

    await expect(llm.call(call)).resolves.toBe('the password is hunter2');
    guard.update({ version: 'v2', checks: [leak('hunter2')] });
    const error = await llm.call(call).catch((e: unknown) => e);

    expect(code(error)).toBe('content_blocked');
    expect(results(events).map((r) => [r.version, r.outcome])).toEqual([
      ['v1', 'passed'],
      ['v2', 'blocked'],
    ]);
  });

  it('lets a call in flight finish on the checks it started with', async () => {
    const holder: { guard?: ReturnType<typeof harness>['guard'] } = {};
    let updated = false;
    const { llm, guard, events } = harness(
      { checks: [] },
      {},
      {
        primary: () => {
          // The new checks arrive while the provider is answering, the first time only.
          if (!updated) {
            updated = true;
            holder.guard!.update({ version: 'v2', checks: [leak('hunter2')] });
          }
          return 'the password is hunter2';
        },
      },
    );
    holder.guard = guard;

    await expect(llm.call(call)).resolves.toBe('the password is hunter2');

    expect(results(events)[0]).toMatchObject({ version: 'v1', outcome: 'passed' });
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
  });

  it('throws on a bad update and keeps the old checks', async () => {
    const { llm, guard } = harness({ checks: [leak('hunter2')] }, {}, { primary: () => 'hunter2' });

    expect(() => guard.update({ version: 'v2', checks: [{ id: 'x' } as Check] })).toThrow(
      /^guardMiddleware: checks\[0\]\.detect must be a function/,
    );
    expect(() => guard.update({ version: 'v2', checks: [leak('a'), leak('b')] })).toThrow(
      /checks\[1\]\.id "leak" is used twice/,
    );
    expect(() => guard.update(null as never)).toThrow(/update must be an object/);
    expect(() => guard.update({ version: 'v2', checks: [], stream: { holdChars: 3 } })).toThrow(
      /holdChars/,
    );

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
  });

  it('needs a new version, because a result names the checks it ran', () => {
    const { guard } = harness({ checks: [] });

    expect(() => guard.update({ version: 'v1', checks: [] })).toThrow(
      /update version must differ from the current one \("v1"\)/,
    );
    expect(() => guard.update({ version: '', checks: [] })).toThrow(/version must be/);
    expect(() => guard.update({ checks: [] } as never)).toThrow(/version/);
  });

  it('never carries findings across versions', async () => {
    const detect = vi.fn<Detector>(() => []);
    const check: Check = { id: 'c', detect };
    const { llm, guard } = harness({ checks: [check] });

    await llm.call(call);
    await llm.call(call);
    expect(detect).toHaveBeenCalledTimes(1);

    guard.update({ version: 'v2', checks: [check] });
    await llm.call(call);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('merges stream options, so a field that is left out keeps its value', async () => {
    const out: Check = { id: 'out', detect: keywords(['hunter2']), action: 'block', on: 'output' };
    const { client } = createStreamClient(
      textDeltas('The password is hunter2 and then more words follow', 10, 12, 9),
    );
    const { llm, guard } = harness({ checks: [out], stream: { release: 'immediate' } }, { client });

    // Only the window changes: the release mode must still be 'immediate'.
    guard.update({ version: 'v2', checks: [out], stream: { windowChars: 4000 } });
    const stream = (await llm.call({ ...call, stream: true as const } as never)) as unknown as {
      chunks: AsyncIterable<{ delta?: string }>;
    };
    let text = '';
    await (async () => {
      for await (const chunk of stream.chunks) text += chunk.delta ?? '';
    })().catch(() => {});

    expect(text.length).toBeGreaterThan(0);
  });

  it('keeps the key, so a value has the same token before and after', async () => {
    const pii: Check = { id: 'pii', detect: patterns(['email']), action: 'redact' };
    const { llm, guard, primary } = harness({ checks: [pii] });

    await llm.call({ ...call, userContent: 'jane@acme.com' });
    guard.update({ version: 'v2', checks: [pii] });
    await llm.call({ ...call, userContent: 'jane@acme.com' });

    expect(lastUserText(primary.calls[1]!)).toBe(lastUserText(primary.calls[0]!));
  });
});
