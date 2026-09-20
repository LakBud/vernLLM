import { describe, expectTypeOf, it } from 'vitest';

import type { ContentCapture, Failure, Outcome, TrackerDeps } from '../../../src/types/tracker.js';
import type { CallResult } from 'vern-llm';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('Outcome', () => {
  it('is a union discriminated by `kind`', () => {
    expectTypeOf<Outcome['kind']>().toEqualTypeOf<'result' | 'error' | 'streamSettled'>();
    expectTypeOf<Extract<Outcome, { kind: 'result' }>['result']>().toEqualTypeOf<CallResult>();
    expectTypeOf<Extract<Outcome, { kind: 'error' }>['error']>().toEqualTypeOf<unknown>();
  });

  it('carries a settled stream failure wrapped, so an undefined rejection stays visible', () => {
    expectTypeOf<Extract<Outcome, { kind: 'streamSettled' }>['failure']>().toEqualTypeOf<
      Failure | undefined
    >();
    expectTypeOf<Failure>().toEqualTypeOf<{ error: unknown }>();
  });
});

describe('ContentCapture', () => {
  it('decides synchronously, so a promise is not an allowed answer', () => {
    expectTypeOf<ReturnType<ContentCapture['decide']>>().toEqualTypeOf<boolean>();
  });
});

describe('TrackerDeps', () => {
  it('makes content capture optional, so a call with capture off pays nothing', () => {
    expectTypeOf<TrackerDeps['content']>().toEqualTypeOf<ContentCapture | undefined>();
  });

  it('resolves the tracer on use through a function', () => {
    expectTypeOf<TrackerDeps['getTracer']>().returns.toHaveProperty('startSpan');
  });
});
