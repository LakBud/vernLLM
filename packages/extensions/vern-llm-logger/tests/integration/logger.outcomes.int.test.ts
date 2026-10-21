import { LLMError, VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import { createMockClient, FakeApiError, settleOutcome, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const BASE = { model: 'gpt-4o', maxRetries: 0, logger: 'silent' as const };

async function run(
  inner: VernLLMMiddleware | undefined,
  client = createMockClient([textResponse('ok')]).client,
) {
  const sink = memorySink();
  const logger = loggerMiddleware({ sink, logger: 'silent' });
  const llm = new VernLLM({ ...BASE, client, middleware: inner ? [inner, logger] : [logger] });
  const outcome = await settleOutcome(llm.call(call));
  return { outcome, sink, records: sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

describe('outcomes', () => {
  // The logger is outermost, so it sees a denial thrown by anything inside it, before any
  // provider is contacted. A denial is the system working, not a fault.
  it.each([
    [
      'a budget',
      new LLMError('tenant over budget', 'quota_exceeded', { code: 'budget_exceeded' as never }),
    ],
    ['a plain quota', new LLMError('over quota', 'quota_exceeded')],
    [
      'a policy denial',
      new LLMError('region not allowed', 'invalid_params', { code: 'policy_denied' as never }),
    ],
  ])('logs %s as rejected at warn', async (_name, denial) => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const denier: VernLLMMiddleware = {
      name: 'denier',
      wrap: async () => {
        throw denial;
      },
    };

    const { outcome, sink, records } = await run(denier, client);

    expect(outcome.ok).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'rejected',
      level: 'warn',
      attempts: 0,
      path: [],
      error: { type: denial.type },
    });
    expect(sink.entries[0]!.level).toBe('warn');
    // Nothing reached a provider.
    expect(calls).toHaveLength(0);
  });

  it('keeps the denial code on the record and the message off it', async () => {
    const denier: VernLLMMiddleware = {
      name: 'denier',
      wrap: async () => {
        throw new LLMError('acme tenant is over budget', 'quota_exceeded', {
          code: 'budget_exceeded' as never,
        });
      },
    };

    const { records } = await run(denier);

    expect(records[0]!.error).toEqual({ type: 'quota_exceeded', code: 'budget_exceeded' });
    expect(JSON.stringify(records[0])).not.toContain('acme');
  });

  it('rethrows a denial exactly as the caller would see it without the logger', async () => {
    const denial = new LLMError('over', 'quota_exceeded');
    const denier: VernLLMMiddleware = {
      name: 'denier',
      wrap: async () => {
        throw denial;
      },
    };

    const { outcome } = await run(denier);

    expect(outcome).toEqual({ ok: false, error: denial });
    expect((outcome as { error: unknown }).error).toBe(denial);
  });

  it('logs a cancelled call as aborted at info, never as an error', async () => {
    const hangs = (_params: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const sink = memorySink();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([hangs]).client,
      middleware: [loggerMiddleware({ sink, logger: 'silent' })],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await settleOutcome(llm.call({ ...call, signal: controller.signal }));

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({ level: 'info', entry: { outcome: 'aborted' } });
  });

  it('logs a provider failure as an error at error', async () => {
    const { records, sink } = await run(
      undefined,
      createMockClient([new FakeApiError('boom', 503)]).client,
    );

    expect(records[0]).toMatchObject({ outcome: 'error', level: 'error', error: { status: 503 } });
    expect(sink.entries[0]!.level).toBe('error');
  });

  it('a non LLM error thrown inside is an error of unknown type', async () => {
    const thrower: VernLLMMiddleware = {
      name: 'thrower',
      wrap: async () => {
        throw new RangeError('boom');
      },
    };

    const { records } = await run(thrower);

    expect(records[0]).toMatchObject({ outcome: 'error', level: 'error' });
    expect(records[0]!.error!.type).toBeTruthy();
    expect(JSON.stringify(records[0])).not.toContain('boom');
  });

  it('a level above info keeps warn and error entries and drops the rest', async () => {
    const sink = memorySink();
    const logger = loggerMiddleware({ sink, level: 'warn', logger: 'silent' });
    const denier: VernLLMMiddleware = {
      name: 'denier',
      wrap: async () => {
        throw new LLMError('over', 'quota_exceeded');
      },
    };

    const fine = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [logger],
    });
    await fine.call(call);
    expect(sink.entries).toHaveLength(0);

    const denied = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [denier, loggerMiddleware({ sink, level: 'warn', logger: 'silent' })],
    });
    await settleOutcome(denied.call(call));
    expect(sink.entries).toHaveLength(1);
  });
});
