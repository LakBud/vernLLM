import { LLMError, VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  loggerMiddleware,
  memorySink,
  type CallLogRecord,
  type LoggerMiddlewareOptions,
} from '../../src/index.js';
import { createMockClient, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const BASE = { model: 'gpt-4o', maxRetries: 0, logger: 'silent' as const };

function setup(options: LoggerMiddlewareOptions = {}, inner: VernLLMMiddleware[] = []) {
  const sink = memorySink();
  const llm = new VernLLM({
    ...BASE,
    client: createMockClient([
      textResponse('ok', { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }),
    ]).client,
    middleware: [...inner, loggerMiddleware({ sink, logger: 'silent', ...options })],
  });
  return { llm, records: () => sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

describe('context', () => {
  it('copies only the allowlisted keys of the call context', async () => {
    const { llm, records } = setup({ context: ['tenantId', 'feature'] });

    await llm.call({
      ...call,
      context: { tenantId: 'acme', feature: 'chat', apiKey: 'sk-secret' },
    });

    expect(records()[0]!.context).toEqual({ tenantId: 'acme', feature: 'chat' });
    expect(JSON.stringify(records()[0])).not.toContain('sk-secret');
  });

  it('writes no context when none is allowed, whatever the call carries', async () => {
    const { llm, records } = setup();

    await llm.call({ ...call, context: { tenantId: 'acme' } });

    expect(records()[0]).not.toHaveProperty('context');
  });
});

describe('custom events', () => {
  const emitter = (name: string, data: unknown): VernLLMMiddleware => ({
    name: `emit-${name}`,
    wrap: async (_request, next, ctx) => {
      ctx.emit(name, data as never);
      return next();
    },
  });

  it('keeps the first party namespaces with no configuration', async () => {
    const { llm, records } = setup({}, [
      emitter('router.decision', { chosen: ['primary'] }),
      emitter('usage.budget_warning', { share: 0.9 }),
      emitter('myapp.thing', { a: 1 }),
    ]);

    await llm.call(call);

    expect(records()[0]!.custom).toEqual({
      'router.decision': [{ chosen: ['primary'] }],
      'usage.budget_warning': [{ share: 0.9 }],
    });
  });

  it('keeps an application namespace once it is listed', async () => {
    const { llm, records } = setup({ customEvents: ['myapp.*'] }, [
      emitter('myapp.thing', { a: 1 }),
    ]);

    await llm.call(call);

    expect(records()[0]!.custom).toEqual({ 'myapp.thing': [{ a: 1 }] });
  });

  it('drops them all when the defaults are switched off', async () => {
    const { llm, records } = setup({ customEvents: { defaults: false } }, [
      emitter('router.decision', { a: 1 }),
    ]);

    await llm.call(call);

    expect(records()[0]).not.toHaveProperty('custom');
  });
});

describe('enrich', () => {
  it('merges a list of helpers in order into fields', async () => {
    const { llm, records } = setup({
      enrich: [
        () => ({ traceId: 'abc', shared: 'first' }),
        () => ({ cost: 0.01, shared: 'second' }),
      ],
    });

    await llm.call(call);

    expect(records()[0]!.fields).toEqual({ traceId: 'abc', cost: 0.01, shared: 'second' });
  });

  it('loses only the fields of a helper that throws, and the call still succeeds', async () => {
    const { llm, records } = setup({
      enrich: [
        () => ({ a: 1 }),
        () => {
          throw new Error('broken');
        },
        () => ({ c: 3 }),
      ],
    });

    expect(await llm.call(call)).toBe('ok');
    expect(records()[0]!.fields).toEqual({ a: 1, c: 3 });
  });

  it('gives a helper the call context, so it can read state other middleware stored', async () => {
    let seen: string | undefined;
    const { llm } = setup({
      enrich: [
        (ctx) => {
          seen = ctx.requestId;
          return undefined;
        },
      ],
    });

    await llm.call(call);

    expect(seen).toBeTruthy();
  });
});

describe('isolation', () => {
  it('concurrent calls never share a record', async () => {
    const sink = memorySink();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([
        async (params) => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
          return textResponse(
            String((params as { messages: Array<{ content: string }> }).messages.at(-1)?.content),
          );
        },
      ]).client,
      middleware: [loggerMiddleware({ sink, logger: 'silent', context: ['n'] })],
    });

    const answers = await Promise.all(
      Array.from({ length: 25 }, (_, n) =>
        llm.call({ ...call, userContent: `q${n}`, context: { n } }),
      ),
    );
    const records = sink.entries.map(({ entry }) => entry as CallLogRecord);

    expect(answers).toHaveLength(25);
    expect(records).toHaveLength(25);
    expect(new Set(records.map((r) => r.requestId)).size).toBe(25);
    expect(new Set(records.map((r) => r.context!.n)).size).toBe(25);
    for (const record of records) {
      expect(record.attempts).toBe(1);
      expect(record.path).toHaveLength(1);
    }
  });

  it('a call that fails does not leak into the next', async () => {
    const sink = memorySink();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([new LLMError('x', 'api', { status: 500 }), textResponse('ok')])
        .client,
      middleware: [loggerMiddleware({ sink, logger: 'silent' })],
    });

    await llm.call(call).catch(() => undefined);
    await llm.call(call);
    const [first, second] = sink.entries.map(({ entry }) => entry as CallLogRecord);

    expect(first!.outcome).toBe('error');
    expect(second).toMatchObject({ outcome: 'ok', attempts: 1, retries: 0 });
    expect(second).not.toHaveProperty('error');
  });
});
