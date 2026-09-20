import { describe, expectTypeOf, it } from 'vitest';

import type { GenAiProviderName } from '../../../src/types/provider.js';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('GenAiProviderName', () => {
  it('accepts a well known provider and any other string', () => {
    expectTypeOf<'openai'>().toExtend<GenAiProviderName>();
    expectTypeOf<'gcp.gemini'>().toExtend<GenAiProviderName>();
    expectTypeOf<'my.private.gateway'>().toExtend<GenAiProviderName>();
    expectTypeOf<string>().toExtend<GenAiProviderName>();
  });

  it('rejects anything that is not a string', () => {
    expectTypeOf<number>().not.toExtend<GenAiProviderName>();
    expectTypeOf<undefined>().not.toExtend<GenAiProviderName>();
  });
});
