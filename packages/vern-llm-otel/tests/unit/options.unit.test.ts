import { createMiddlewareRef, requireRef } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_LENGTH,
  normalizeOptions,
  type OtelMiddlewareOptions,
} from '../../src/options.js';

// Deliberately wrong values, so the runtime checks are exercised and not just the types.
const bad = (value: unknown) => value as never;

describe('normalizeOptions defaults', () => {
  it('resolves every default from no options at all', () => {
    const config = normalizeOptions(undefined);

    expect(config).toMatchObject({
      tracer: undefined,
      meter: undefined,
      metrics: true,
      genAiConventions: true,
      normalizeModel: undefined,
      attributes: undefined,
      middlewareEvents: false,
      exceptions: undefined,
      logger: undefined,
      name: 'otel',
      priority: -1000,
      runsAfter: [],
      capture: undefined,
    });
  });

  it('treats an empty object like no options', () => {
    expect(normalizeOptions({}).priority).toBe(-1000);
  });
});

describe('normalizeOptions rejections', () => {
  const cases: [string, OtelMiddlewareOptions, RegExp][] = [
    ['null options', bad(null), /options must be an object/],
    ['array options', bad([]), /options must be an object/],
    ['string options', bad('x'), /options must be an object/],
    ['non boolean metrics', { metrics: bad('yes') }, /metrics must be a boolean/],
    ['non boolean genAiConventions', { genAiConventions: bad(1) }, /genAiConventions/],
    ['non boolean middlewareEvents', { middlewareEvents: bad(0) }, /middlewareEvents/],
    [
      'non function normalizeModel',
      { normalizeModel: bad('x') },
      /normalizeModel must be a function/,
    ],
    ['non function attributes', { attributes: bad({}) }, /attributes must be a function/],
    ['empty name', { name: '' }, /name must be a non-empty string/],
    ['whitespace name', { name: '   ' }, /name must be a non-empty string/],
    ['non string name', { name: bad(5) }, /name must be a non-empty string/],
    ['NaN priority', { priority: Number.NaN }, /priority must be a finite number/],
    ['Infinity priority', { priority: Number.POSITIVE_INFINITY }, /priority/],
    ['string priority', { priority: bad('1') }, /priority/],
    ['non array runsAfter', { runsAfter: bad({}) }, /runsAfter must be an array/],
    ['string logger other than silent', { logger: bad('loud') }, /logger must be/],
    ['null logger', { logger: bad(null) }, /logger must be/],
    ['array providerNames', { providerNames: bad([]) }, /providerNames must be an object/],
    ['null providerNames', { providerNames: bad(null) }, /providerNames must be an object/],
    ['empty provider name', { providerNames: { primary: '' } }, /providerNames\["primary"\]/],
    ['blank provider name', { providerNames: { primary: '  ' } }, /providerNames\["primary"\]/],
    ['non string provider name', { providerNames: { primary: bad(1) } }, /providerNames/],
    ['string captureContent', { captureContent: bad('yes') }, /captureContent must be/],
    ['null captureContent', { captureContent: bad(null) }, /captureContent must be/],
    ['array captureContent', { captureContent: bad([]) }, /captureContent must be/],
    ['non boolean capture input', { captureContent: { input: bad('y') } }, /captureContent\.input/],
    [
      'non boolean capture output',
      { captureContent: { output: bad(1) } },
      /captureContent\.output/,
    ],
    [
      'non boolean capture systemInstructions',
      { captureContent: { systemInstructions: bad(1) } },
      /captureContent\.systemInstructions/,
    ],
    [
      'non boolean capture toolDefinitions',
      { captureContent: { toolDefinitions: bad(1) } },
      /captureContent\.toolDefinitions/,
    ],
    ['non function redact', { captureContent: { redact: bad('x') } }, /captureContent\.redact/],
    ['non function when', { captureContent: { when: bad(true) } }, /captureContent\.when/],
    ['string recordExceptions', { recordExceptions: bad('yes') }, /recordExceptions must be/],
    ['null recordExceptions', { recordExceptions: bad(null) }, /recordExceptions must be/],
    ['array recordExceptions', { recordExceptions: bad([]) }, /recordExceptions must be/],
    ['non boolean stack', { recordExceptions: { stack: bad('y') } }, /recordExceptions\.stack/],
  ];

  it.each(cases)('throws a plain Error for %s', (_label, options, message) => {
    let thrown: unknown;
    try {
      normalizeOptions(options);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('Error');
    expect((thrown as Error).message).toMatch(message);
    expect((thrown as Error).message.startsWith('otelMiddleware: ')).toBe(true);
  });
});

describe('captureContent.maxLength', () => {
  it.each([0, -1, -Infinity, Number.NaN, 1.5, 0.1])('rejects %s', (maxLength) => {
    expect(() => normalizeOptions({ captureContent: { maxLength } })).toThrow(/maxLength/);
  });

  it.each(['10', null, {}, true])('rejects the non number %j', (maxLength) => {
    expect(() => normalizeOptions({ captureContent: { maxLength: bad(maxLength) } })).toThrow(
      /maxLength/,
    );
  });

  it.each([1, 2, 8192, 1_000_000, Number.POSITIVE_INFINITY])('accepts %s', (maxLength) => {
    expect(normalizeOptions({ captureContent: { maxLength } }).capture?.maxLength).toBe(maxLength);
  });

  it('defaults to 8192', () => {
    expect(DEFAULT_MAX_LENGTH).toBe(8192);
    expect(normalizeOptions({ captureContent: true }).capture?.maxLength).toBe(8192);
  });
});

describe('captureContent resolution', () => {
  it('is off for undefined and false', () => {
    expect(normalizeOptions({}).capture).toBeUndefined();
    expect(normalizeOptions({ captureContent: false }).capture).toBeUndefined();
  });

  it('true resolves to the documented group defaults with no when', () => {
    expect(normalizeOptions({ captureContent: true }).capture).toEqual({
      input: true,
      output: true,
      systemInstructions: true,
      toolDefinitions: false,
      maxLength: 8192,
      redact: undefined,
      when: undefined,
      anyGroup: true,
    });
  });

  it('an empty object resolves like true', () => {
    expect(normalizeOptions({ captureContent: {} }).capture).toEqual(
      normalizeOptions({ captureContent: true }).capture,
    );
  });

  it('keeps explicit groups, redact, and when', () => {
    const redact = (text: string) => text;
    const when = () => true;

    const capture = normalizeOptions({
      captureContent: { input: false, toolDefinitions: true, redact, when },
    }).capture;

    expect(capture).toMatchObject({
      input: false,
      output: true,
      systemInstructions: true,
      toolDefinitions: true,
      redact,
      when,
      anyGroup: true,
    });
  });

  it('reports no enabled group when all four are off', () => {
    const capture = normalizeOptions({
      captureContent: { input: false, output: false, systemInstructions: false },
    }).capture;

    expect(capture?.anyGroup).toBe(false);
  });
});

describe('genAiConventions: false', () => {
  it('drops content capture, whose attributes are all gen_ai ones', () => {
    const config = normalizeOptions({ genAiConventions: false, captureContent: true });

    expect(config.capture).toBeUndefined();
    expect(config.priority).toBe(-1000);
  });

  it('still validates the capture options', () => {
    expect(() =>
      normalizeOptions({ genAiConventions: false, captureContent: { maxLength: 0 } }),
    ).toThrow(/maxLength/);
  });
});

describe('default priority', () => {
  const ref = createMiddlewareRef('redaction');

  it.each<[string, OtelMiddlewareOptions, number]>([
    ['capture off', {}, -1000],
    ['capture on, no runsAfter', { captureContent: true }, 1000],
    ['capture on, empty runsAfter', { captureContent: true, runsAfter: [] }, 1000],
    ['capture on with runsAfter', { captureContent: true, runsAfter: [ref] }, -1000],
    [
      'capture on with a required ref',
      { captureContent: true, runsAfter: [requireRef(ref)] },
      -1000,
    ],
    [
      'capture object with no enabled group',
      { captureContent: { input: false, output: false, systemInstructions: false } },
      -1000,
    ],
    ['runsAfter but capture off', { runsAfter: [ref] }, -1000],
  ])('%s', (_label, options, expected) => {
    expect(normalizeOptions(options).priority).toBe(expected);
  });

  it('an explicit priority always wins, including zero', () => {
    expect(normalizeOptions({ captureContent: true, priority: 0 }).priority).toBe(0);
    expect(normalizeOptions({ priority: 5 }).priority).toBe(5);
    expect(normalizeOptions({ priority: -Number.MAX_VALUE }).priority).toBe(-Number.MAX_VALUE);
  });
});

describe('runsAfter', () => {
  it('passes entries through untouched, in a copy of the array', () => {
    const ref = createMiddlewareRef('a');
    const required = requireRef(createMiddlewareRef('b'));
    const input = [ref, required];

    const config = normalizeOptions({ runsAfter: input });

    expect(config.runsAfter).toEqual(input);
    expect(config.runsAfter[0]).toBe(ref);
    expect(config.runsAfter[1]).toBe(required);
    expect(config.runsAfter).not.toBe(input);
  });

  it('does not validate entries, so the core can name the bad one', () => {
    expect(() => normalizeOptions({ runsAfter: [bad('not a ref')] })).not.toThrow();
  });
});

describe('providerName', () => {
  it('maps configured labels', () => {
    const { providerName } = normalizeOptions({
      providerNames: { primary: 'openai', 'fallback[0]': 'anthropic' },
    });

    expect(providerName('primary')).toBe('openai');
    expect(providerName('fallback[0]')).toBe('anthropic');
  });

  it('falls back to the raw label for anything unmapped', () => {
    const { providerName } = normalizeOptions({ providerNames: { primary: 'openai' } });

    expect(providerName('fallback[1]')).toBe('fallback[1]');
    expect(providerName('')).toBe('');
  });

  it('never resolves object prototype keys', () => {
    const { providerName } = normalizeOptions({});

    for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(providerName(label)).toBe(label);
    }
  });

  it('is unaffected by later mutation of the caller object', () => {
    const names: Record<string, string> = { primary: 'openai' };
    const { providerName } = normalizeOptions({ providerNames: names });

    names.primary = 'changed';
    names['fallback[0]'] = 'added';

    expect(providerName('primary')).toBe('openai');
    expect(providerName('fallback[0]')).toBe('fallback[0]');
  });

  it('accepts any non empty string, not only well known values', () => {
    expect(
      normalizeOptions({ providerNames: { primary: 'my.gateway' } }).providerName('primary'),
    ).toBe('my.gateway');
  });
});

describe('passthrough options', () => {
  it('keeps explicit values', () => {
    const logger = { debug() {}, warn() {}, error() {} };
    const normalizeModel = (model: string) => model;
    const attributes = () => undefined;

    const config = normalizeOptions({
      metrics: false,
      genAiConventions: false,
      middlewareEvents: true,
      name: 'telemetry',
      logger,
      normalizeModel,
      attributes,
    });

    expect(config).toMatchObject({
      metrics: false,
      genAiConventions: false,
      middlewareEvents: true,
      name: 'telemetry',
      logger,
      normalizeModel,
      attributes,
    });
  });

  it("accepts 'silent' as a logger", () => {
    expect(normalizeOptions({ logger: 'silent' }).logger).toBe('silent');
  });
});

describe('recordExceptions', () => {
  it('is off by default and for false', () => {
    expect(normalizeOptions({}).exceptions).toBeUndefined();
    expect(normalizeOptions({ recordExceptions: false }).exceptions).toBeUndefined();
  });

  it('true records without a stack', () => {
    expect(normalizeOptions({ recordExceptions: true }).exceptions).toEqual({ stack: false });
  });

  it('an object defaults the stack to off and keeps an explicit choice', () => {
    expect(normalizeOptions({ recordExceptions: {} }).exceptions).toEqual({ stack: false });
    expect(normalizeOptions({ recordExceptions: { stack: true } }).exceptions).toEqual({
      stack: true,
    });
  });
});
