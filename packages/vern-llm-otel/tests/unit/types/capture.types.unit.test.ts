import { describe, expectTypeOf, it } from 'vitest';

import type { CaptureContentOptions } from '../../../src/types/capture.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('CaptureContentOptions', () => {
  it('has every field optional', () => {
    expectTypeOf<{}>().toExtend<CaptureContentOptions>();
  });

  it('types the group switches and the length limit', () => {
    expectTypeOf<CaptureContentOptions['input']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<CaptureContentOptions['output']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<CaptureContentOptions['systemInstructions']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<CaptureContentOptions['toolDefinitions']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<CaptureContentOptions['maxLength']>().toEqualTypeOf<number | undefined>();
  });

  it('takes a text to text redactor', () => {
    expectTypeOf<CaptureContentOptions['redact']>().toEqualTypeOf<
      ((text: string) => string) | undefined
    >();
  });

  it('makes `when` synchronous, so a promise is a type error', () => {
    expectTypeOf<NonNullable<CaptureContentOptions['when']>>().toEqualTypeOf<
      (ctx: PreDispatchContext, request: Readonly<WireCallRequest>) => boolean
    >();
    expectTypeOf<() => Promise<boolean>>().not.toExtend<
      NonNullable<CaptureContentOptions['when']>
    >();
  });
});
