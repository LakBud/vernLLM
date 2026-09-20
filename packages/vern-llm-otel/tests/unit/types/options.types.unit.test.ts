import { describe, expectTypeOf, it } from 'vitest';

import type { CaptureContentOptions } from '../../../src/types/capture.js';
import type { RecordExceptionsOptions } from '../../../src/types/exceptions.js';
import type { OtelMiddlewareOptions } from '../../../src/types/options.js';
import type { GenAiProviderName } from '../../../src/types/provider.js';
import type { Attributes } from '@opentelemetry/api';
import type { Logger, PreDispatchContext } from 'vern-llm';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('OtelMiddlewareOptions', () => {
  it('has every option optional, so a bare call is valid', () => {
    expectTypeOf<{}>().toExtend<OtelMiddlewareOptions>();
  });

  it('lets content capture and exception recording be a flag or a config object', () => {
    expectTypeOf<OtelMiddlewareOptions['captureContent']>().toEqualTypeOf<
      boolean | CaptureContentOptions | undefined
    >();
    expectTypeOf<OtelMiddlewareOptions['recordExceptions']>().toEqualTypeOf<
      boolean | RecordExceptionsOptions | undefined
    >();
  });

  it('maps target labels to provider names read only', () => {
    expectTypeOf<OtelMiddlewareOptions['providerNames']>().toEqualTypeOf<
      Readonly<Record<string, GenAiProviderName>> | undefined
    >();
  });

  it('takes synchronous callbacks that return plain values', () => {
    expectTypeOf<NonNullable<OtelMiddlewareOptions['normalizeModel']>>().toEqualTypeOf<
      (model: string) => string
    >();
    expectTypeOf<NonNullable<OtelMiddlewareOptions['attributes']>>().toEqualTypeOf<
      (ctx: PreDispatchContext) => Attributes | undefined
    >();
    expectTypeOf<() => Promise<string>>().not.toExtend<
      NonNullable<OtelMiddlewareOptions['normalizeModel']>
    >();
  });

  it('accepts a Logger or the string silent for the logger, and nothing else', () => {
    expectTypeOf<Logger>().toExtend<NonNullable<OtelMiddlewareOptions['logger']>>();
    expectTypeOf<'silent'>().toExtend<NonNullable<OtelMiddlewareOptions['logger']>>();
    expectTypeOf<'loud'>().not.toExtend<NonNullable<OtelMiddlewareOptions['logger']>>();
  });

  it('types the ordering options', () => {
    expectTypeOf<OtelMiddlewareOptions['priority']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<OtelMiddlewareOptions['name']>().toEqualTypeOf<string | undefined>();
  });
});
