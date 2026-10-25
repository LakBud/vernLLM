import { describe, expect, it } from 'vitest';

import { buildRecord } from '../../../../src/internal/recorder/buildRecord.utils.js';

import type { RecordInput } from '../../../../src/internal/recorder/recordInput.types.js';

const base = (): RecordInput => ({
  requestId: 'req_1',
  endedAt: new Date('2026-01-02T03:04:05.678Z'),
  classified: { outcome: 'ok', level: 'info' },
  answered: undefined,
  attempts: 0,
  retries: 0,
  streaming: false,
  cache: undefined,
  ttftMs: undefined,
  shortCircuitedBy: undefined,
  durationMs: 12.3456789,
  queueWaitMs: 0,
  retryDelayMs: 0,
  attemptMs: undefined,
  generationMs: undefined,
  chains: undefined,
  path: [],
  usage: undefined,
  usageFailed: false,
  breaker: [],
  middleware: [],
  custom: new Map(),
  context: undefined,
  fields: undefined,
});

describe('buildRecord', () => {
  it('writes only what happened', () => {
    const record = buildRecord(base());

    expect(record).toEqual({
      kind: 'call',
      v: 1,
      ts: '2026-01-02T03:04:05.678Z',
      requestId: 'req_1',
      outcome: 'ok',
      level: 'info',
      attempts: 0,
      retries: 0,
      streaming: false,
      durationMs: 12.346,
      queueWaitMs: 0,
      retryDelayMs: 0,
      path: [],
    });
    expect(Object.keys(record)).not.toContain('usage');
    expect(Object.keys(record)).not.toContain('error');
  });

  it('includes everything that was recorded', () => {
    const record = buildRecord({
      ...base(),
      classified: { outcome: 'error', level: 'error', error: { type: 'api', status: 500 } },
      answered: { provider: 'primary', model: 'gpt-4o', fallbackIndex: -1 },
      shortCircuitedBy: 'guard',
      path: [{ provider: 'primary', model: 'gpt-4o', attempts: 1, outcome: 'error', elapsedMs: 5 }],
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, requestId: 'r', model: 'm' },
      breaker: [{ provider: 'primary', model: 'm', from: 'closed', to: 'open' }],
      middleware: [{ kind: 'transform', name: 'patcher', patchedFields: ['temperature'] }],
      custom: new Map([['usage.budget_warning', [{ share: 0.9 }]]]),
      context: { tenantId: 'acme' },
      fields: { traceId: 'abc' },
    });

    expect(record).toMatchObject({
      provider: 'primary',
      model: 'gpt-4o',
      fallbackIndex: -1,
      shortCircuitedBy: 'guard',
      error: { type: 'api', status: 500 },
      breaker: [{ to: 'open' }],
      middleware: [{ kind: 'transform', patchedFields: ['temperature'] }],
      custom: { 'usage.budget_warning': [{ share: 0.9 }] },
      context: { tenantId: 'acme' },
      fields: { traceId: 'abc' },
    });
  });

  it('freezes the record and everything it owns', () => {
    const record = buildRecord({
      ...base(),
      path: [{ provider: 'p', model: 'm', attempts: 1, outcome: 'ok', elapsedMs: 1 }],
      breaker: [{ provider: 'p', model: 'm', from: 'a', to: 'b' }],
      middleware: [{ kind: 'enabled_skip', name: 'n' }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, requestId: 'r', model: 'm' },
      context: { a: 1 },
      fields: { b: 2 },
    });

    for (const frozen of [
      record,
      record.path,
      record.path[0],
      record.breaker,
      record.breaker?.[0],
      record.middleware,
      record.middleware?.[0],
      record.usage,
      record.context,
      record.fields,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
  });

  it('copies the path and usage, so later changes to the inputs cannot reach the record', () => {
    const input = base();
    input.path = [{ provider: 'p', model: 'm', attempts: 1, outcome: 'ok', elapsedMs: 1 }];
    input.usage = {
      promptTokens: 1,
      completionTokens: 5,
      totalTokens: 6,
      requestId: 'r',
      model: 'm',
    };
    const record = buildRecord(input);

    (input.path[0] as { attempts: number }).attempts = 99;
    input.usage.promptTokens = 99;

    expect(record.path[0]!.attempts).toBe(1);
    expect(record.usage!.promptTokens).toBe(1);
  });

  it('marks usage as failed only when there is usage', () => {
    expect(buildRecord({ ...base(), usageFailed: true })).not.toHaveProperty('usageFailed');

    const usage = {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      requestId: 'r',
      model: 'm',
    };
    expect(buildRecord({ ...base(), usage, usageFailed: true }).usageFailed).toBe(true);
    expect(buildRecord({ ...base(), usage, usageFailed: false })).not.toHaveProperty('usageFailed');
  });

  it('writes token counts only, never the call context a usage object carries', () => {
    const usage = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      requestId: 'r',
      model: 'm',
      provider: 'primary',
      usedFallback: false,
      context: { tenantId: 'acme', apiKey: 'sk-secret' },
    };
    const record = buildRecord({ ...base(), usage });

    expect(record.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(JSON.stringify(record)).not.toContain('sk-secret');
  });

  it('adds the token rate from the answering attempt', () => {
    const usage = {
      promptTokens: 1,
      completionTokens: 50,
      totalTokens: 51,
      requestId: 'r',
      model: 'm',
    };

    expect(buildRecord({ ...base(), usage, generationMs: 500 }).outputTokensPerSec).toBe(100);
    expect(buildRecord({ ...base(), usage })).not.toHaveProperty('outputTokensPerSec');
  });
});
