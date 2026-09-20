import { describe, expectTypeOf, it } from 'vitest';

import type {
  CapturedInput,
  InputMessage,
  Part,
  TextPart,
  ToolCallPart,
  ToolCallResponsePart,
} from '../../../src/types/content.js';

// Compile time guarantees only: `pnpm run typecheck:test` fails if any line below stops holding.
describe('content parts', () => {
  it('is a union discriminated by `type`', () => {
    expectTypeOf<Part['type']>().toEqualTypeOf<'text' | 'tool_call' | 'tool_call_response'>();
    expectTypeOf<Extract<Part, { type: 'text' }>>().toEqualTypeOf<TextPart>();
    expectTypeOf<Extract<Part, { type: 'tool_call' }>>().toEqualTypeOf<ToolCallPart>();
    expectTypeOf<
      Extract<Part, { type: 'tool_call_response' }>
    >().toEqualTypeOf<ToolCallResponsePart>();
  });

  it('requires a tool call name and text content, and leaves ids optional', () => {
    expectTypeOf<{ type: 'tool_call' }>().not.toExtend<ToolCallPart>();
    expectTypeOf<{ type: 'tool_call'; name: string }>().toExtend<ToolCallPart>();
    expectTypeOf<{ type: 'text' }>().not.toExtend<TextPart>();
  });
});

describe('InputMessage', () => {
  it('has no system role, because system messages become system instructions', () => {
    expectTypeOf<InputMessage['role']>().toEqualTypeOf<'user' | 'assistant' | 'tool'>();
  });
});

describe('CapturedInput', () => {
  it('has three optional serialized groups', () => {
    expectTypeOf<CapturedInput>().toEqualTypeOf<{
      inputMessages?: string;
      systemInstructions?: string;
      toolDefinitions?: string;
    }>();
  });
});
