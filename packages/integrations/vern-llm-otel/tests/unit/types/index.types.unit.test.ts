import { describe, expectTypeOf, it } from 'vitest';

import type { CaptureContentOptions } from '../../../src/types/capture.js';
import type { CapturedInput, InputMessage, Part } from '../../../src/types/content.js';
import type { RecordExceptionsOptions } from '../../../src/types/exceptions.js';
import type * as barrel from '../../../src/types/index.js';
import type { OtelMiddlewareOptions } from '../../../src/types/options.js';
import type { GenAiProviderName } from '../../../src/types/provider.js';
import type { ResolvedCapture, ResolvedConfig } from '../../../src/types/resolvedConfig.js';
import type { ContentCapture, Outcome, TrackerDeps } from '../../../src/types/tracker.js';

// Compile time guarantees only: `pnpm run typecheck:test` fails if the barrel drops a name or
// re-exports a different type under it.
describe('types barrel', () => {
  it('re-exports the public option types', () => {
    expectTypeOf<barrel.GenAiProviderName>().toEqualTypeOf<GenAiProviderName>();
    expectTypeOf<barrel.CaptureContentOptions>().toEqualTypeOf<CaptureContentOptions>();
    expectTypeOf<barrel.RecordExceptionsOptions>().toEqualTypeOf<RecordExceptionsOptions>();
    expectTypeOf<barrel.OtelMiddlewareOptions>().toEqualTypeOf<OtelMiddlewareOptions>();
  });

  it('re-exports the internal types every internal file imports through it', () => {
    expectTypeOf<barrel.ResolvedConfig>().toEqualTypeOf<ResolvedConfig>();
    expectTypeOf<barrel.ResolvedCapture>().toEqualTypeOf<ResolvedCapture>();
    expectTypeOf<barrel.ContentCapture>().toEqualTypeOf<ContentCapture>();
    expectTypeOf<barrel.TrackerDeps>().toEqualTypeOf<TrackerDeps>();
    expectTypeOf<barrel.Outcome>().toEqualTypeOf<Outcome>();
    expectTypeOf<barrel.Part>().toEqualTypeOf<Part>();
    expectTypeOf<barrel.InputMessage>().toEqualTypeOf<InputMessage>();
    expectTypeOf<barrel.CapturedInput>().toEqualTypeOf<CapturedInput>();
  });
});
