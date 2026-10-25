import { describe, expect, it } from 'vitest';

import { compile } from '../../../../src/internal/options/compile.utils.js';

import type { PolicyOptions } from '../../../../src/index.js';

/** Casts a deliberately wrong value, the way a JavaScript caller or a bad config file would. */
const wrong = (options: unknown) => options as PolicyOptions;

const targets = {
  'openai-us': { region: 'us', zdr: false },
  'openai-eu': { region: 'eu', zdr: true },
};

describe('compile', () => {
  it('lets an error that is not about the pattern through, rather than hiding it', () => {
    const pattern = {
      get region(): string {
        throw new Error('getter failed');
      },
    };
    expect(() => compile({ targets, rules: [{ id: 'a', forbid: pattern }] })).toThrow(
      'getter failed',
    );
  });

  describe('a valid policy', () => {
    it('defaults to allow with no rules and no targets', () => {
      const policy = compile({});
      expect(policy.default).toBe('allow');
      expect(policy.rules).toEqual([]);
      expect(policy.declared).toEqual({});
      expect(policy.needs).toEqual({
        inputTokens: false,
        images: false,
        labels: false,
        readsLabels: false,
        functions: false,
      });
    });

    it('compiles every kind of rule', () => {
      const policy = compile({
        default: 'deny',
        targets,
        rules: [
          { id: 'a', allow: { region: 'eu' } },
          { id: 'b', forbid: { zdr: false }, when: { context: { plan: 'free' } } },
          { id: 'c', forbid: 'all' },
        ],
      });

      expect(policy.default).toBe('deny');
      expect(policy.rules.map((rule) => rule.id)).toEqual(['a', 'b', 'c']);
      expect(policy.rules[0]!.allow).toBeTypeOf('function');
      expect(policy.rules[1]!.when).toBeTypeOf('function');
      expect(policy.rules[2]!.forbid!({})).toBe(true);
    });

    it('resolves the version, onError and modes', () => {
      const policy = compile({
        version: '2026-10-24.1',
        onError: 'open',
        mode: 'audit',
        rules: [
          { id: 'inherits', forbid: 'all' },
          { id: 'enforced', forbid: 'all', mode: 'enforce' },
        ],
      });

      expect(policy.version).toBe('2026-10-24.1');
      expect(policy.onError).toBe('open');
      expect(policy.auditDefault).toBe(true);
      expect(policy.rules.map((rule) => rule.mode)).toEqual(['audit', 'enforce']);
    });

    it('defaults to closed, enforce and no version', () => {
      const policy = compile({ rules: [{ id: 'a', forbid: 'all' }] });

      expect(policy.version).toBeUndefined();
      expect(Object.hasOwn(policy, 'version')).toBe(false);
      expect(policy.onError).toBe('closed');
      expect(policy.auditDefault).toBe(false);
      expect(policy.rules[0]!.mode).toBe('enforce');
    });

    it('takes an audit mode on a single rule', () => {
      const policy = compile({
        rules: [{ id: 'a', forbid: 'all', mode: 'audit' }],
      });
      expect(policy.rules[0]!.mode).toBe('audit');
    });

    it('is frozen, and copies the declared attributes', () => {
      const declared = { 'openai-eu': { region: 'eu' } };
      const policy = compile({ targets: declared });

      declared['openai-eu'].region = 'us';
      expect(policy.declared['openai-eu']).toEqual({ region: 'eu' });
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.rules)).toBe(true);
      expect(Object.isFrozen(policy.declared['openai-eu'])).toBe(true);
    });

    it('keeps a target named __proto__ as plain data', () => {
      const policy = compile(
        wrong(JSON.parse('{ "targets": { "__proto__": { "region": "eu" } } }')),
      );
      expect(Object.hasOwn(policy.declared, '__proto__')).toBe(true);
    });

    it('takes the built in attributes and the declared ones in a pattern', () => {
      expect(() =>
        compile({
          targets,
          rules: [
            { id: 'a', forbid: { name: 'x', model: 'y', provider: 'z', region: 'us', zdr: false } },
          ],
        }),
      ).not.toThrow();
    });

    it('does not check a function, which is opaque', () => {
      expect(() =>
        compile({ rules: [{ id: 'a', forbid: (facts) => facts.anything === 'x' }] }),
      ).not.toThrow();
    });
  });

  describe('options', () => {
    it.each([
      ['options that are not an object', 'nope', 'options must be an object'],
      ['null options', null, 'options must be an object'],
      ['an unknown option', { rulez: [] }, 'unknown option "rulez"'],
      [
        'a default that is not allow or deny',
        { default: 'maybe' },
        `default must be 'allow' or 'deny'`,
      ],
      ['rules that are not an array', { rules: {} }, 'rules must be an array'],
      ['a blank version', { version: '  ' }, 'version must be a non empty string'],
      ['a version that is not a string', { version: 2 }, 'version must be a non empty string'],
      [
        'an onError that is not closed or open',
        { onError: 'shut' },
        `onError must be 'closed' or 'open'`,
      ],
      ['a mode that is not enforce or audit', { mode: 'dry' }, `mode must be 'enforce' or 'audit'`],
      ['targets that are not an object', { targets: [] }, 'targets must be an object'],
    ])('rejects %s', (_label, options, message) => {
      expect(() => compile(wrong(options))).toThrow(`policyMiddleware: ${message}`);
    });
  });

  describe('targets', () => {
    it.each([
      ['an entry that is not an object', { x: 'eu' }, 'targets["x"] must be an object'],
      ['a non scalar attribute', { x: { region: ['eu'] } }, 'targets["x"].region must be a string'],
      ['a null attribute', { x: { region: null } }, 'targets["x"].region must be a string'],
      ['the built in name', { x: { name: 'y' } }, 'targets["x"].name is a reserved name'],
      ['the built in model', { x: { model: 'y' } }, 'targets["x"].model is a reserved name'],
      [
        'the built in provider',
        { x: { provider: 'y' } },
        'targets["x"].provider is a reserved name',
      ],
      ['the operator not', { x: { not: true } }, 'targets["x"].not is a reserved name'],
      ['the operator any', { x: { any: true } }, 'targets["x"].any is a reserved name'],
      ['the operator gte', { x: { gte: 1 } }, 'targets["x"].gte is a reserved name'],
    ])('rejects %s', (_label, declared, message) => {
      expect(() => compile(wrong({ targets: declared }))).toThrow(message);
    });

    it('rejects an attribute called __proto__', () => {
      const declared = JSON.parse('{ "x": { "__proto__": "eu" } }') as Record<string, never>;
      expect(() => compile({ targets: declared })).toThrow('targets["x"].__proto__ is a reserved');
    });
  });

  describe('rules', () => {
    it.each([
      ['a rule that is not an object', ['x'], 'rules[0] must be an object'],
      [
        'an unknown field',
        [{ id: 'a', forbid: 'all', flags: { x: true } }],
        'rules[0] has an unknown field "flags"',
      ],
      ['a missing id', [{ forbid: 'all' }], 'rules[0].id must be a non empty string'],
      [
        'a rule mode that is not enforce or audit',
        [{ id: 'a', forbid: 'all', mode: 'dry' }],
        `rules[0].mode must be 'enforce' or 'audit'`,
      ],
      [
        'the id reserved for the default',
        [{ id: 'default', forbid: 'all' }],
        'rules[0].id "default" is reserved',
      ],
      ['a blank id', [{ id: '  ', forbid: 'all' }], 'rules[0].id must be a non empty string'],
      [
        'an id that is not a string',
        [{ id: 1, forbid: 'all' }],
        'rules[0].id must be a non empty string',
      ],
      [
        'a repeated id',
        [
          { id: 'a', forbid: 'all' },
          { id: 'a', forbid: 'all' },
        ],
        'rules[1].id "a" is used by another rule',
      ],
      [
        'both allow and forbid',
        [{ id: 'a', allow: { name: 'x' }, forbid: { name: 'y' } }],
        'rule "a" must have only one of allow and forbid',
      ],
      ['neither allow nor forbid', [{ id: 'a' }], 'rule "a" must have allow, forbid or set'],
      [
        'allow all, which only forbid takes',
        [{ id: 'a', allow: 'all' }],
        'rule "a" allow must be a pattern',
      ],
      [
        'a forbid that is not a pattern or all',
        [{ id: 'a', forbid: 'none' }],
        'rule "a" forbid must be a pattern',
      ],
      [
        'an empty forbid, which would remove everything',
        [{ id: 'a', forbid: {} }],
        'rule "a" forbid must have at least one key',
      ],
    ])('rejects %s', (_label, rules, message) => {
      expect(() => compile(wrong({ rules }))).toThrow(`policyMiddleware: ${message}`);
    });
  });

  describe('attribute names, checked against the declared targets', () => {
    it('names the rule and the attribute for a typo', () => {
      expect(() =>
        compile({ targets, rules: [{ id: 'eu-residency', forbid: { not: { regoin: 'eu' } } }] }),
      ).toThrow(
        'rule "eu-residency" forbid uses the unknown attribute "regoin". Known attributes: model, name, provider, region, zdr',
      );
    });

    it('checks allow too, and looks through any', () => {
      expect(() =>
        compile({
          targets,
          rules: [{ id: 'a', allow: { any: [{ region: 'eu' }, { zdi: true }] } }],
        }),
      ).toThrow('rule "a" allow uses the unknown attribute "zdi"');
    });

    it('accepts only the built in names when no target declares anything', () => {
      expect(() => compile({ rules: [{ id: 'a', forbid: { model: 'x' } }] })).not.toThrow();
      expect(() => compile({ rules: [{ id: 'a', forbid: { region: 'eu' } }] })).toThrow(
        'unknown attribute "region". Known attributes: model, name, provider',
      );
    });

    it('accepts an attribute declared on any one target', () => {
      expect(() =>
        compile({
          targets: { a: { region: 'eu' }, b: { zdr: true } },
          rules: [{ id: 'x', forbid: { zdr: true } }],
        }),
      ).not.toThrow();
    });
  });

  describe('when', () => {
    it('accepts the call facts', () => {
      expect(() =>
        compile({
          rules: [
            {
              id: 'a',
              forbid: 'all',
              when: {
                context: { plan: 'free' },
                request: { hasTools: true, jsonOutput: false, streaming: true },
                callTargets: true,
              },
            },
          ],
        }),
      ).not.toThrow();
    });

    it.each([
      [
        'a fact that does not exist',
        { colour: 'red' },
        'rule "a" when uses "colour", which is not a call fact',
      ],
      [
        'a context that is not a pattern',
        { context: 'eu' },
        "when.context must be a pattern over the call's context",
      ],
      [
        'a request that is not a pattern',
        { request: true },
        'when.request must be a pattern over the request facts',
      ],
      [
        'an unknown request fact',
        { request: { hasTool: true } },
        'when.request uses the unknown fact "hasTool"',
      ],
      [
        'an unknown request fact inside not',
        { request: { not: { image: true } } },
        'unknown fact "image"',
      ],
      [
        'callTargets that is not a boolean',
        { callTargets: 'yes' },
        'when.callTargets must be true or false',
      ],
      ['an unknown fact inside any', { any: [{ callTargets: true }, { nope: 1 }] }, 'uses "nope"'],
    ])('rejects %s', (_label, when, message) => {
      expect(() => compile(wrong({ rules: [{ id: 'a', forbid: 'all', when }] }))).toThrow(message);
    });

    it('checks the facts inside a not as well', () => {
      expect(() =>
        compile({ rules: [{ id: 'a', forbid: 'all', when: { not: { callTargets: true } } }] }),
      ).not.toThrow();
      expect(() =>
        compile(wrong({ rules: [{ id: 'a', forbid: 'all', when: { not: { nope: 1 } } }] })),
      ).toThrow('uses "nope", which is not a call fact');
    });

    it('tells a rule that matches on labels from a function, which only may read them', () => {
      const labels = () => ['pii'];
      const declarative = compile({
        labels,
        rules: [{ id: 'a', forbid: 'all', when: { labels: 'pii' } }],
      });
      const function_ = compile({ labels, rules: [{ id: 'a', forbid: 'all', when: () => true }] });

      expect(declarative.needs).toMatchObject({
        labels: true,
        readsLabels: true,
        functions: false,
      });
      expect(function_.needs).toMatchObject({ labels: true, readsLabels: false, functions: true });
    });

    it('leaves the costly facts off when no rule reads them', () => {
      const policy = compile({
        rules: [{ id: 'a', forbid: 'all', when: { request: { hasTools: true } } }],
      });
      expect(policy.needs).toEqual({
        inputTokens: false,
        images: false,
        labels: false,
        readsLabels: false,
        functions: false,
      });
    });

    it('records the costly facts a rule reads, through not and any', () => {
      const tokens = compile({
        rules: [{ id: 'a', forbid: 'all', when: { request: { inputTokens: { gte: 1000 } } } }],
      });
      expect(tokens.needs).toEqual({
        inputTokens: true,
        images: false,
        labels: false,
        readsLabels: false,
        functions: false,
      });

      const images = compile({
        rules: [
          { id: 'a', forbid: 'all', when: { any: [{ request: { not: { images: true } } }] } },
        ],
      });
      expect(images.needs).toEqual({
        inputTokens: false,
        images: true,
        labels: false,
        readsLabels: false,
        functions: false,
      });
    });

    it('needs everything for a function, which can read anything', () => {
      const policy = compile({ rules: [{ id: 'a', forbid: 'all', when: () => true }] });
      expect(policy.needs).toEqual({
        inputTokens: true,
        images: true,
        labels: true,
        readsLabels: false,
        functions: true,
      });
    });

    it.each([
      ['context', { context: { any: [() => true] } }],
      ['request', { request: { not: () => true } }],
    ])('needs everything for a function nested in %s', (_name, when) => {
      const policy = compile({ rules: [{ id: 'a', forbid: 'all', when }] });
      expect(policy.needs).toMatchObject({ inputTokens: true, images: true, functions: true });
    });
  });
});

describe('compile flags, exceptions and labels', () => {
  describe('set', () => {
    it('makes a rule on its own, with no allow or forbid', () => {
      const policy = compile({ rules: [{ id: 'a', set: { logContent: false } }] });
      expect(policy.rules[0]!.set).toEqual({ logContent: false });
      expect(policy.rules[0]!.allow).toBeUndefined();
      expect(policy.rules[0]!.forbid).toBeUndefined();
    });

    it('goes alongside an allow or a forbid', () => {
      expect(() =>
        compile({
          targets,
          rules: [
            { id: 'a', forbid: { zdr: false }, set: { duplicateSends: false } },
            { id: 'b', allow: { region: 'eu' }, set: { logContent: true } },
          ],
        }),
      ).not.toThrow();
    });

    it.each([
      ['an empty object', {}, 'rule "a" set must be an object of at least one flag'],
      ['a list', [true], 'rule "a" set must be an object of at least one flag'],
      ['a flag that is not a boolean', { x: 'no' }, 'rule "a" set.x must be true or false'],
      ['a flag that is a number', { x: 0 }, 'rule "a" set.x must be true or false'],
      ['an empty flag name', { ' ': true }, 'rule "a" set has an invalid flag name'],
    ])('rejects %s', (_name, set, message) => {
      expect(() => compile(wrong({ rules: [{ id: 'a', set }] }))).toThrow(
        `policyMiddleware: ${message}`,
      );
    });

    it('keeps a flag named __proto__ out of the prototype', () => {
      const set = JSON.parse('{ "__proto__": true }') as Record<string, boolean>;
      expect(() => compile({ rules: [{ id: 'a', set }] })).toThrow('invalid flag name');
    });
  });

  describe('except', () => {
    const when = { context: { tenant: 'acme' } };
    const rule = (except: unknown) => wrong({ rules: [{ id: 'a', forbid: 'all', except }] });

    it('accepts the last day of a month and the 29th of February in a leap year', () => {
      const policy = compile(
        rule([
          { when, until: '2028-02-29', reason: 'leap' },
          { when, until: '2026-04-30', reason: 'end' },
          { when, until: '2026-12-31T23:59:59-11:00', reason: 'late' },
        ]),
      );
      const [leap, end] = policy.rules[0]!.except;
      expect(leap!.end).toBe(Date.UTC(2028, 1, 29));
      expect(end!.end).toBe(Date.UTC(2026, 3, 30));
    });

    it('reads the end as an instant, exclusive', () => {
      const policy = compile(
        rule([
          { when, until: '2026-11-01', reason: 'DPA' },
          { when, until: '2026-11-01T12:00:00+01:00', reason: 'DPA' },
        ]),
      );
      const [date, dateTime] = policy.rules[0]!.except;
      expect(date!.end).toBe(Date.UTC(2026, 10, 1));
      expect(dateTime!.end).toBe(Date.UTC(2026, 10, 1, 11));
      expect(date!.until).toBe('2026-11-01');
      expect(date!.reason).toBe('DPA');
    });

    it.each([
      ['an empty list', [], 'must be a non empty list of exceptions'],
      ['something that is not a list', {}, 'must be a non empty list of exceptions'],
      ['an exception that is not an object', ['x'], 'except[0] must be an object'],
      [
        'an unknown field',
        [{ when, until: '2026-11-01', reason: 'r', note: 'x' }],
        'except[0] has an unknown field "note"',
      ],
      [
        'no when',
        [{ until: '2026-11-01', reason: 'r' }],
        'except[0].when is required, since an exception with none would cover every call',
      ],
      [
        'no until, so it could never expire',
        [{ when, reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'a date that is not ISO',
        [{ when, until: 'next week', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'a date and time with no zone',
        [{ when, until: '2026-11-01T12:00:00', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'a date that does not exist',
        [{ when, until: '2026-13-45', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'a day the month does not have',
        [{ when, until: '2026-02-31', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'a day after the end of a thirty day month',
        [{ when, until: '2026-04-31', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'the 29th of February in a year that is not a leap year',
        [{ when, until: '2026-02-29', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'midnight written as hour 24',
        [{ when, until: '2026-11-01T24:00:00Z', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      [
        'an offset of more than a day',
        [{ when, until: '2026-11-01T12:00:00+25:00', reason: 'r' }],
        'except[0].until is required and must be an ISO date',
      ],
      ['no reason', [{ when, until: '2026-11-01' }], 'except[0].reason must be a non empty string'],
      [
        'a blank reason',
        [{ when, until: '2026-11-01', reason: '  ' }],
        'except[0].reason must be a non empty string',
      ],
    ])('rejects %s', (_name, except, message) => {
      expect(() => compile(rule(except))).toThrow(message);
    });

    it('checks the when like any other', () => {
      expect(() =>
        compile(rule([{ when: { colour: 'x' }, until: '2026-11-01', reason: 'r' }])),
      ).toThrow('uses "colour", which is not a call fact');
    });

    it('notes the costly facts an exception reads', () => {
      const policy = compile(
        rule([{ when: { request: { images: true } }, until: '2026-11-01', reason: 'r' }]),
      );
      expect(policy.needs.images).toBe(true);
    });
  });

  describe('labels', () => {
    const labeled = (when: unknown) =>
      wrong({ labels: () => ['pii'], rules: [{ id: 'a', forbid: 'all', when }] });

    it('is a function', () => {
      expect(() => compile(wrong({ labels: ['pii'] }))).toThrow(
        'policyMiddleware: labels must be a function',
      );
    });

    it('is required by a rule that matches on labels', () => {
      expect(() =>
        compile(wrong({ rules: [{ id: 'a', forbid: 'all', when: { labels: 'pii' } }] })),
      ).toThrow('rule "a" when matches on labels, so the labels option is required');
    });

    it('is required by an exception that matches on labels too', () => {
      expect(() =>
        compile(
          wrong({
            rules: [
              {
                id: 'a',
                forbid: 'all',
                except: [{ when: { labels: 'pii' }, until: '2026-11-01', reason: 'r' }],
              },
            ],
          }),
        ),
      ).toThrow('matches on labels, so the labels option is required');
    });

    it('is required through not and any as well', () => {
      expect(() =>
        compile(
          wrong({
            rules: [{ id: 'a', forbid: 'all', when: { not: { any: [{ labels: 'pii' }] } } }],
          }),
        ),
      ).toThrow('the labels option is required');
    });

    it('needs the labeler to run once a rule reads labels', () => {
      expect(compile(labeled({ labels: ['pii', 'health'] })).needs.labels).toBe(true);
    });

    it('does not run when no rule reads labels', () => {
      const policy = compile(wrong({ labels: () => ['pii'], rules: [{ id: 'a', forbid: 'all' }] }));
      expect(policy.needs.labels).toBe(false);
    });

    it('treats a key called labels inside context as an ordinary key', () => {
      const policy = compile(
        wrong({ rules: [{ id: 'a', forbid: 'all', when: { context: { labels: 'pii' } } }] }),
      );
      expect(policy.needs.labels).toBe(false);
    });

    it.each([
      ['an empty list', []],
      ['an empty label', ''],
      ['a number', 3],
      ['a list holding a number', ['pii', 3]],
    ])('rejects %s as the labels to match', (_name, value) => {
      expect(() => compile(labeled({ labels: value }))).toThrow(
        'must be a label, or a non empty list of labels',
      );
    });
  });
});
