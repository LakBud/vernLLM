import { describe, expectTypeOf, it } from 'vitest';

import type { RecordExceptionsOptions } from '../../../src/types/exceptions.js';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('RecordExceptionsOptions', () => {
  it('has stack as its only, optional, boolean field', () => {
    expectTypeOf<RecordExceptionsOptions>().toEqualTypeOf<{ stack?: boolean }>();
    expectTypeOf<{}>().toExtend<RecordExceptionsOptions>();
  });

  it('rejects a stack that is not a boolean', () => {
    expectTypeOf<{ stack: 'yes' }>().not.toExtend<RecordExceptionsOptions>();
  });
});
