import { describe, expect, it, vi } from 'vitest';

import { keywords, patterns, type Check, type Detector } from '../../src/index.js';
import { harness } from '../helpers.js';

const pii: Check = { id: 'pii', detect: patterns(['email']) };
const secrets: Check = { id: 'secrets', detect: patterns(['secrets']), action: 'block' };
const awsKey = 'AKIAIOSFODNN7EXAMPLE';

describe('evaluate', () => {
  it('gives the result a call would have, and makes no call', async () => {
    const { guard, primary } = harness({ checks: [pii, secrets] });

    const result = await guard.evaluate({
      messages: [{ role: 'user', content: 'write to jane@acme.com' }],
    });

    expect(result).toMatchObject({
      v: 1,
      version: 'v1',
      outcome: 'labeled',
      labels: ['pii'],
      input: { checks: { pii: { found: 1, kinds: ['email'] }, secrets: { found: 0 } } },
    });
    expect(result.output).toBeUndefined();
    expect(primary.calls).toHaveLength(0);
  });

  it('treats text as a user message, and reports a block', async () => {
    const { guard } = harness({ checks: [pii, secrets] });

    const result = await guard.evaluate({ text: `key ${awsKey}` });

    expect(result).toMatchObject({
      outcome: 'blocked',
      input: { checks: { secrets: { found: 1 } } },
    });
  });

  it('reports redact as redacted, and audit checks as what they would do', async () => {
    const { guard } = harness({
      checks: [
        { id: 'r', detect: patterns(['email']), action: 'redact' },
        { id: 'a', detect: keywords(['x']), action: 'block', mode: 'audit' },
      ],
    });

    const result = await guard.evaluate({ text: 'jane@acme.com and x' });

    expect(result.outcome).toBe('redacted');
    expect(result.input.audit).toEqual({ a: 'block' });
  });

  it("checks an answer with phase 'output', against the checks on output only", async () => {
    const out: Check = { id: 'out', detect: keywords(['hunter2']), action: 'block', on: 'output' };
    const { guard } = harness({ checks: [pii, out] });

    const clean = await guard.evaluate({ text: 'jane@acme.com', phase: 'output' });
    const bad = await guard.evaluate({ text: 'the word is hunter2', phase: 'output' });

    expect(clean.outcome).toBe('passed');
    expect(clean.output).toMatchObject({
      checks: { out: { found: 0 } },
      restored: 0,
      unrestored: 0,
    });
    expect(bad).toMatchObject({ outcome: 'blocked', output: { checks: { out: { found: 1 } } } });
  });

  it('runs a check that is marked parallel too, and reads the context for when', async () => {
    const detect = vi.fn<Detector>(() => [{ segment: 0 }]);
    const { guard } = harness({
      checks: [
        {
          id: 'p',
          detect,
          action: 'block',
          parallel: true,
          when: (ctx) => (ctx.context as { tenant?: string } | undefined)?.tenant === 'acme',
        },
      ],
    });

    expect((await guard.evaluate({ text: 'x' })).outcome).toBe('passed');
    expect((await guard.evaluate({ text: 'x', context: { tenant: 'acme' } })).outcome).toBe(
      'blocked',
    );
  });

  it('says labels are unknown when a labeling check cannot answer', async () => {
    const broken: Detector = () => {
      throw new Error('boom');
    };
    const { guard } = harness({ checks: [{ id: 'b', detect: broken }] });

    const result = await guard.evaluate({ text: 'x' });

    expect(result.labels).toBeUndefined();
    expect(result.input.errors).toEqual([{ check: 'b', name: 'Error' }]);
  });

  it.each([
    ['neither', {}],
    ['both', { text: 'a', messages: [{ role: 'user' as const, content: 'a' }] }],
    [
      'messages for output',
      { messages: [{ role: 'user' as const, content: 'a' }], phase: 'output' as const },
    ],
    ['a bad phase', { text: 'a', phase: 'both' as never }],
  ])('rejects %s', async (_name, input) => {
    const { guard } = harness({ checks: [] });

    await expect(guard.evaluate(input)).rejects.toThrow(/^guardMiddleware: evaluate/);
  });

  it('rejects something that is not an object', async () => {
    const { guard } = harness({ checks: [] });
    await expect(guard.evaluate(null as never)).rejects.toThrow(/evaluate needs an object/);
  });
});

describe('redactText', () => {
  const checks: Check[] = [
    { id: 'pii', detect: patterns(['email']), action: 'redact' },
    secrets,
    { id: 'label', detect: keywords(['project-x']) },
    { id: 'audit', detect: keywords(['audited']), action: 'block', mode: 'audit' },
  ];

  it('masks what redact and block checks find, wherever they are pointed', () => {
    const { guard } = harness({ checks });

    expect(guard.redactText(`mail jane@acme.com with ${awsKey}`)).toBe(
      'mail [EMAIL] with [SECRETS]',
    );
    expect(guard.redactText('mail jane@acme.com')).toBe('mail [EMAIL]');
  });

  it('leaves alone what only labels or only audits, and text with nothing in it', () => {
    const { guard } = harness({ checks });

    expect(guard.redactText('project-x is audited')).toBe('project-x is audited');
    expect(guard.redactText('')).toBe('');
  });

  it('skips a check that answers with a promise, because it must be synchronous', () => {
    const slow: Detector = async () => [{ segment: 0, start: 0, end: 1 }];
    const { guard } = harness({ checks: [{ id: 's', detect: slow, action: 'block' }] });

    expect(guard.redactText('abc')).toBe('abc');
  });

  it('masks the whole text when a check that must not fail breaks, or finds something unlocated', () => {
    const broken: Detector = () => {
      throw new Error('boom');
    };
    const unlocated: Detector = () => [{ segment: 0 }];
    const closed = harness({ checks: [{ id: 'b', detect: broken, action: 'block' }] });
    const open = harness({
      checks: [{ id: 'b', detect: broken, action: 'block', onError: 'open' }],
    });
    const where = harness({ checks: [{ id: 'u', detect: unlocated, action: 'redact' }] });

    expect(closed.guard.redactText('secret')).toBe('[REDACTED]');
    expect(open.guard.redactText('secret')).toBe('secret');
    expect(where.guard.redactText('secret')).toBe('[REDACTED]');
  });

  it('follows an update', () => {
    const { guard } = harness({ checks: [] });
    expect(guard.redactText('jane@acme.com')).toBe('jane@acme.com');

    guard.update({
      version: 'v2',
      checks: [{ id: 'pii', detect: patterns(['email']), action: 'redact' }],
    });

    expect(guard.redactText('jane@acme.com')).toBe('[EMAIL]');
  });
});
