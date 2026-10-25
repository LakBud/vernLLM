import { describe, expect, it } from 'vitest';

import {
  policyMiddleware,
  type Decision,
  type EvaluateInput,
  type PolicyOptions,
} from '../../src/index.js';
import { harness } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const targets: EvaluateInput['targets'] = [
  { name: 'primary', model: 'primary-model' },
  { name: 'b', model: 'b-model' },
  { name: 'c', model: 'c-model' },
];

const declared = {
  primary: { region: 'us', zdr: false },
  b: { region: 'eu', zdr: true },
  c: { region: 'eu', zdr: false },
};

/** What a decision looks like once emitted, to compare with a real call's event. */
function asEvent(decision: Decision) {
  return {
    outcome: decision.outcome,
    removed: decision.removed,
    flags: decision.flagCauses,
    exceptions: decision.exceptions,
    audit: decision.audit,
    errors: decision.errors.map(({ rule, name }) => ({
      ...(rule !== undefined && { rule }),
      name,
    })),
    ...(decision.labels !== undefined && { labels: decision.labels }),
  };
}

const swallow = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

describe('evaluate', () => {
  describe('gives the decision a real call gets', () => {
    const cases: [string, PolicyOptions, Record<string, string> | undefined][] = [
      ['no rules', {}, undefined],
      ['a forbid', { rules: [{ id: 'no-b', forbid: { name: 'b' } }] }, undefined],
      [
        'a rule that depends on the context, applying',
        {
          targets: declared,
          rules: [
            { id: 'eu', forbid: { not: { region: 'eu' } }, when: { context: { region: 'eu' } } },
          ],
        },
        { region: 'eu' },
      ],
      [
        'a rule that depends on the context, not applying',
        {
          targets: declared,
          rules: [
            { id: 'eu', forbid: { not: { region: 'eu' } }, when: { context: { region: 'eu' } } },
          ],
        },
        { region: 'us' },
      ],
      [
        'default deny with an allow',
        { default: 'deny', rules: [{ id: 'only-c', allow: { name: 'c' } }] },
        undefined,
      ],
      ['a denial', { rules: [{ id: 'lockout', forbid: 'all' }] }, undefined],
      [
        'flags',
        { rules: [{ id: 'pii', set: { duplicateSends: false, cacheable: true } }] },
        undefined,
      ],
      [
        'an exception that covers the call',
        {
          rules: [
            {
              id: 'no-primary',
              forbid: { name: 'primary' },
              except: [
                { when: { context: { tenant: 'acme' } }, until: '2099-01-01', reason: 'DPA' },
              ],
            },
          ],
        },
        { tenant: 'acme' },
      ],
      [
        'an audit rule',
        { rules: [{ id: 'trial', forbid: { name: ['b', 'c'] }, mode: 'audit' }] },
        undefined,
      ],
      [
        'a rule that throws',
        {
          rules: [
            {
              id: 'broken',
              forbid: { name: 'b' },
              when: () => {
                throw new Error('boom');
              },
            },
          ],
        },
        undefined,
      ],
    ];

    it.each(cases)('%s', async (_name, policyOptions, context) => {
      const { llm, policy, events } = harness({ version: 'v1', ...policyOptions });

      await swallow(llm.call({ ...call, ...(context && { context }) }));
      const decision = policy.evaluate({ targets, ...(context && { context }) });

      const { v, version, ...emitted } = events[0]!.data as Record<string, unknown>;
      expect(v).toBe(1);
      expect(version).toBe('v1');
      expect(asEvent(decision)).toEqual(emitted);
      expect(decision.version).toBe('v1');
    });
  });

  it('makes no call and emits nothing', () => {
    const { policy, tried, events } = harness({ rules: [{ id: 'a', forbid: { name: 'b' } }] });

    policy.evaluate({ targets });

    expect(tried()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps the order the targets came in', () => {
    const { policy } = harness({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });

    const decision = policy.evaluate({ targets: [...targets].reverse() });

    expect(decision.allowed).toEqual(['c', 'primary']);
  });

  it('reads the provider a target reports', () => {
    const { policy } = harness({ rules: [{ id: 'no-openai', forbid: { provider: 'openai' } }] });

    const decision = policy.evaluate({
      targets: [
        { name: 'primary', model: 'm', provider: 'openai' },
        { name: 'b', model: 'm', provider: 'anthropic' },
        { name: 'c', model: 'm' },
      ],
    });

    expect(decision.removed).toEqual({ primary: 'no-openai' });
  });

  it('reads the model it is given, as an override would change it', () => {
    const { policy } = harness({ rules: [{ id: 'no-big', forbid: { model: 'gpt-big' } }] });

    const decision = policy.evaluate({
      targets: [
        { name: 'primary', model: 'gpt-big' },
        { name: 'b', model: 'b-model' },
      ],
    });

    expect(decision.removed).toEqual({ primary: 'no-big' });
  });

  describe('the request', () => {
    const rules = [
      { id: 'no-images', forbid: 'all' as const, when: { request: { images: true } } },
      { id: 'big', set: { big: false }, when: { request: { inputTokens: { gte: 1000 } } } },
    ];

    it('takes the facts it is given, and treats the rest as false or zero', () => {
      const { policy } = harness({ rules });

      expect(policy.evaluate({ targets }).outcome).toBe('allowed');
      expect(policy.evaluate({ targets, request: { images: true } }).outcome).toBe('denied');
      expect(policy.evaluate({ targets, request: { inputTokens: 5000 } }).flags).toEqual({
        big: false,
      });
    });
  });

  describe('labels', () => {
    const labels = () => ['unused'];
    const rules = [{ id: 'pii', forbid: { name: 'primary' }, when: { labels: 'pii' } }];

    it('are what the labeler would have said', () => {
      const { policy } = harness({ labels, rules });

      expect(policy.evaluate({ targets, labels: ['pii'] }).removed).toEqual({ primary: 'pii' });
      expect(policy.evaluate({ targets, labels: [] }).removed).toEqual({});
    });

    it('are unknown when left out, and follow onError', () => {
      const { policy } = harness({ labels, rules });

      const decision = policy.evaluate({ targets });

      expect(decision.labels).toBe('unknown');
      expect(decision.removed).toEqual({ primary: 'pii' });
    });
  });

  describe('now', () => {
    const rules = [
      {
        id: 'no-primary',
        forbid: { name: 'primary' },
        except: [{ when: { context: { tenant: 'acme' } }, until: '2026-11-01', reason: 'DPA' }],
      },
    ];
    const context = { tenant: 'acme' };

    it('settles whether an exception has ended, as a Date or a number', () => {
      const { policy } = harness({ rules });
      const end = Date.UTC(2026, 10, 1);

      expect(policy.evaluate({ targets, context, now: new Date(end - 1) }).removed).toEqual({});
      expect(policy.evaluate({ targets, context, now: new Date(end) }).removed).toEqual({
        primary: 'no-primary',
      });
      expect(policy.evaluate({ targets, context, now: end - 1 }).exceptions).toHaveLength(1);
    });

    it('is the clock when left out', () => {
      const withUntil = (until: string) => [
        {
          id: 'no-primary',
          forbid: { name: 'primary' },
          except: [{ when: { context: { tenant: 'acme' } }, until, reason: 'DPA' }],
        },
      ];

      const ended = harness({ rules: withUntil('2020-01-01') }).policy;
      const running = harness({ rules: withUntil('2099-01-01') }).policy;

      expect(ended.evaluate({ targets, context }).removed).toEqual({ primary: 'no-primary' });
      expect(running.evaluate({ targets, context }).removed).toEqual({});
    });
  });

  it('uses the policy as it stands after an update', () => {
    const { policy } = harness({ version: 'v1', rules: [{ id: 'a', forbid: { name: 'b' } }] });

    expect(policy.evaluate({ targets }).removed).toEqual({ b: 'a' });
    policy.update({ version: 'v2', rules: [{ id: 'z', forbid: { name: 'c' } }] });

    const decision = policy.evaluate({ targets });
    expect(decision.removed).toEqual({ c: 'z' });
    expect(decision.version).toBe('v2');
  });

  describe('given input that is not a call', () => {
    it.each([
      ['no targets', {}, 'evaluate input must be an object with a list of targets'],
      ['null', null, 'evaluate input must be an object with a list of targets'],
      [
        'a target with no model',
        { targets: [{ name: 'a' }] },
        'evaluate targets[0] must be an object with a name and a model',
      ],
      [
        'a target that is a string',
        { targets: ['a'] },
        'evaluate targets[0] must be an object with a name and a model',
      ],
      [
        'a now that is not a time',
        { targets, now: 'soon' },
        'evaluate now must be a Date or a number',
      ],
      [
        'a request that is a string',
        { targets, request: 'x' },
        'evaluate request must be an object',
      ],
      ['a request that is a list', { targets, request: [] }, 'evaluate request must be an object'],
      [
        'a request fact that does not exist',
        { targets, request: { hasTool: true } },
        'evaluate request has an unknown fact "hasTool"',
      ],
      [
        'a request fact of the wrong type',
        { targets, request: { images: 'yes' } },
        'evaluate request.images must be true or false',
      ],
      [
        'a negative token count',
        { targets, request: { inputTokens: -1 } },
        'evaluate request.inputTokens must be a number of at least 0',
      ],
      [
        'labels that are not strings',
        { targets, labels: ['pii', 1] },
        'evaluate labels must be a list of strings',
      ],
      [
        'a provider that is not a string',
        { targets: [{ name: 'a', model: 'm', provider: 3 }] },
        'evaluate targets[0].provider must be a string when it is given',
      ],
    ])('rejects %s', (_name, input, message) => {
      const { policy } = harness();
      expect(() => policy.evaluate(input as never)).toThrow(`policyMiddleware: ${message}`);
    });
  });

  describe('with a rule that is a function', () => {
    const writes = (id: string) => ({
      id,
      forbid: { name: 'b' },
      when: (facts: unknown) => {
        (facts as { context: { n: number } }).context.n = 99;
        return true;
      },
    });

    it('cannot change the context it was given, which counts as the rule failing', () => {
      const { policy } = harness({ rules: [writes('w')] });
      const context = { n: 1 };

      const decision = policy.evaluate({ targets, context });

      expect(context).toEqual({ n: 1 });
      expect(decision.errors).toEqual([
        {
          rule: 'w',
          name: 'TypeError',
          message: 'a policy function must not change the facts of a call',
        },
      ]);
      expect(decision.removed).toEqual({ b: 'w' });
    });

    it('cannot change what a later rule sees, whatever order the rules are in', () => {
      const reads = {
        id: 'r',
        forbid: { name: 'c' },
        when: (facts: unknown) => (facts as { context: { n: number } }).context.n === 1,
      };
      const forward = harness({ rules: [writes('w'), reads] }).policy;
      const backward = harness({ rules: [reads, writes('w')] }).policy;

      const input = { targets, context: { n: 1 } };

      expect(forward.evaluate(input).removed).toEqual(backward.evaluate(input).removed);
      expect(forward.evaluate(input).removed).toEqual({ b: 'w', c: 'r' });
    });

    it('is told so in a real call, and the caller keeps its own context', async () => {
      const { llm, events } = harness({ rules: [writes('w')] });
      const context = { n: 1 };

      await swallow(llm.call({ ...call, context }));

      expect(context).toEqual({ n: 1 });
      expect(events[0]!.data).toMatchObject({ errors: [{ rule: 'w', name: 'TypeError' }] });
    });
  });

  it('counts a label given twice once', () => {
    const { policy } = harness({
      labels: () => undefined,
      rules: [{ id: 'p', forbid: { name: 'b' }, when: { labels: 'pii' } }],
    });

    expect(policy.evaluate({ targets, labels: ['pii', 'pii', 'a'] }).labels).toEqual(['a', 'pii']);
  });
});

/** The recipes page of the docs, so what it promises is checked against the real policy. */
describe('the recipes in the docs', () => {
  const pick = (
    policy: ReturnType<typeof policyMiddleware>,
    input: Omit<EvaluateInput, 'targets'>,
    names: string[],
  ) => policy.evaluate({ ...input, targets: names.map((name) => ({ name, model: 'm' })) });

  it('keeps a region on its own targets, except for a customer with a signed agreement', () => {
    const policy = policyMiddleware({
      logger: 'silent',
      targets: {
        'openai-us': { region: 'us' },
        'openai-eu': { region: 'eu' },
        anthropic: { region: 'us' },
      },
      rules: [
        {
          id: 'eu-residency',
          forbid: { not: { region: 'eu' } },
          when: { context: { region: 'eu' } },
          except: [
            {
              when: { context: { tenantId: 'acme' } },
              until: '2999-01-01',
              reason: 'DPA signed, migration pending',
            },
          ],
        },
      ],
    });
    const names = ['openai-us', 'openai-eu', 'anthropic'];

    expect(pick(policy, { context: { region: 'eu' } }, names).allowed).toEqual(['openai-eu']);
    expect(pick(policy, { context: { region: 'us' } }, names).allowed).toEqual(names);
    const acme = pick(policy, { context: { region: 'eu', tenantId: 'acme' } }, names);
    expect(acme.allowed).toEqual(names);
    expect(acme.exceptions).toEqual([
      { rule: 'eu-residency', reason: 'DPA signed, migration pending', until: '2999-01-01' },
    ]);
  });

  it('gives each plan its own models, with allows adding up', () => {
    const policy = policyMiddleware({
      logger: 'silent',
      default: 'deny',
      targets: { mini: { tier: 'small' }, large: { tier: 'large' }, claude: { tier: 'large' } },
      rules: [
        { id: 'everyone-small', allow: { tier: 'small' } },
        {
          id: 'paid-large',
          allow: { tier: 'large' },
          when: { context: { plan: ['pro', 'team'] } },
        },
      ],
    });
    const names = ['mini', 'large', 'claude'];

    expect(pick(policy, { context: { plan: 'free' } }, names).allowed).toEqual(['mini']);
    expect(pick(policy, { context: { plan: 'pro' } }, names).allowed).toEqual(names);
  });

  it('sends content with PII only where nothing is kept, and treats unknown labels as PII', () => {
    const policy = policyMiddleware({
      logger: 'silent',
      targets: { keeps: { zdr: false }, forgets: { zdr: true } },
      labels: () => undefined,
      rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
    });
    const names = ['keeps', 'forgets'];

    expect(pick(policy, { labels: ['pii'] }, names).allowed).toEqual(['forgets']);
    expect(pick(policy, { labels: [] }, names).allowed).toEqual(names);
    expect(pick(policy, {}, names).allowed).toEqual(['forgets']);
  });

  it('refuses a suspended tenant before anything is spent', () => {
    const policy = policyMiddleware({
      logger: 'silent',
      rules: [{ id: 'suspended', forbid: 'all', when: { context: { tenantStatus: 'suspended' } } }],
    });

    expect(pick(policy, { context: { tenantStatus: 'suspended' } }, ['a', 'b']).outcome).toBe(
      'denied',
    );
    expect(pick(policy, { context: { tenantStatus: 'active' } }, ['a', 'b']).outcome).toBe(
      'allowed',
    );
  });

  it('keeps long prompts off short context models, and tool calls off providers without tools', () => {
    const policy = policyMiddleware({
      logger: 'silent',
      targets: {
        small: { window: 'short', tools: false },
        big: { window: 'long', tools: true },
      },
      rules: [
        {
          id: 'long-prompts',
          forbid: { window: 'short' },
          when: { request: { inputTokens: { gte: 30_000 } } },
        },
        {
          id: 'tools-need-support',
          forbid: { not: { tools: true } },
          when: { request: { hasTools: true } },
        },
      ],
    });
    const names = ['small', 'big'];

    expect(pick(policy, { request: { inputTokens: 40_000 } }, names).allowed).toEqual(['big']);
    expect(pick(policy, { request: { inputTokens: 100 } }, names).allowed).toEqual(names);
    expect(pick(policy, { request: { hasTools: true } }, names).removed).toEqual({
      small: 'tools-need-support',
    });
  });

  it('allows only the targets on a list, and nothing else', () => {
    const policy = policyMiddleware({
      logger: 'silent',
      default: 'deny',
      rules: [{ id: 'approved', allow: { name: ['openai-eu', 'anthropic'] } }],
    });

    expect(pick(policy, {}, ['openai-us', 'openai-eu', 'anthropic']).allowed).toEqual([
      'openai-eu',
      'anthropic',
    ]);
    expect(pick(policy, {}, ['openai-us']).outcome).toBe('denied');
  });
});
