import { describe, expectTypeOf, it } from 'vitest';

import type { ResolvedCapture, ResolvedConfig } from '../../../src/types/resolvedConfig.js';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('ResolvedConfig', () => {
  it('has no optional fields, so no other file repeats a default', () => {
    expectTypeOf<Required<ResolvedConfig>>().toEqualTypeOf<ResolvedConfig>();
  });

  it('resolves the switches to plain booleans', () => {
    expectTypeOf<ResolvedConfig['metrics']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResolvedConfig['genAiConventions']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResolvedConfig['middlewareEvents']>().toEqualTypeOf<boolean>();
  });

  it('uses undefined, not false, for a feature that is off', () => {
    expectTypeOf<ResolvedConfig['capture']>().toEqualTypeOf<ResolvedCapture | undefined>();
    expectTypeOf<ResolvedConfig['exceptions']>().toEqualTypeOf<{ stack: boolean } | undefined>();
  });

  it('maps a target label and model to a provider name that is always a string', () => {
    expectTypeOf<ResolvedConfig['providerName']>().toEqualTypeOf<
      (label: string, model: string) => string
    >();
    expectTypeOf<ResolvedConfig['targetName']>().toEqualTypeOf<(label: string) => string>();
  });
});

describe('ResolvedCapture', () => {
  it('has every group switch resolved and a numeric length limit', () => {
    expectTypeOf<ResolvedCapture['input']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResolvedCapture['output']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResolvedCapture['systemInstructions']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResolvedCapture['toolDefinitions']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResolvedCapture['maxLength']>().toEqualTypeOf<number>();
    expectTypeOf<ResolvedCapture['anyGroup']>().toEqualTypeOf<boolean>();
  });
});
