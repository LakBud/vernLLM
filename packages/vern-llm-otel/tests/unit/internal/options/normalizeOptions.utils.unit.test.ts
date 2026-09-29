import { createMiddlewareRef, requireRef } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { OtelMiddlewareOptions } from '../../../../src/types/index.js';

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
      customEvents: { data: false, maxLength: 8192 },
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
    ['string customEvents', { customEvents: bad('yes') }, /customEvents must be/],
    ['null customEvents', { customEvents: bad(null) }, /customEvents must be/],
    ['array customEvents', { customEvents: bad([]) }, /customEvents must be/],
    ['non boolean customEvents data', { customEvents: { data: bad('y') } }, /customEvents\.data/],
    ['zero customEvents maxLength', { customEvents: { maxLength: 0 } }, /customEvents\.maxLength/],
    [
      'null customEvents maxLength',
      { customEvents: { maxLength: bad(null) } },
      /customEvents\.maxLength/,
    ],
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

  // Capture reads the request at dispatch, after every transform, so it never needs a late slot.
  it.each<[string, OtelMiddlewareOptions]>([
    ['capture off', {}],
    ['capture on', { captureContent: true }],
    ['capture on with runsAfter', { captureContent: true, runsAfter: [ref] }],
    ['capture on with a required ref', { captureContent: true, runsAfter: [requireRef(ref)] }],
    ['runsAfter but capture off', { runsAfter: [ref] }],
  ])('%s', (_label, options) => {
    expect(normalizeOptions(options).priority).toBe(-1000);
  });

  it('an explicit priority always wins, including zero', () => {
    expect(normalizeOptions({ captureContent: true, priority: 0 }).priority).toBe(0);
    expect(
      normalizeOptions({ captureContent: true, runsAfter: [ref], priority: -1000 }).priority,
    ).toBe(-1000);
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

describe('customEvents', () => {
  it.each<[string, OtelMiddlewareOptions['customEvents'], unknown]>([
    ['omitted', undefined, { data: false, maxLength: 8192 }],
    ['true', true, { data: false, maxLength: 8192 }],
    ['an empty object', {}, { data: false, maxLength: 8192 }],
    ['false', false, undefined],
    ['data on', { data: true }, { data: true, maxLength: 8192 }],
    ['data off explicitly', { data: false }, { data: false, maxLength: 8192 }],
    ['a length', { maxLength: 100 }, { data: false, maxLength: 100 }],
    ['an infinite length', { maxLength: Infinity }, { data: false, maxLength: Infinity }],
  ])('resolves %s', (_label, option, expected) => {
    expect(normalizeOptions({ customEvents: option }).customEvents).toEqual(expected);
  });

  it('keeps data out by default, since it is whatever a middleware chose to emit', () => {
    expect(normalizeOptions({}).customEvents?.data).toBe(false);
  });
});
