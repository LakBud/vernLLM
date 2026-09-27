import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { type CallParams, defineTool, isToolCallResult } from '../../../../src/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  drain,
  toolCallResponse,
} from '../../../helpers.js';
import { stringSchema } from './vernLLM.tools.helpers.js';

// defineTool()-wrapped, distinct-schema pair for the typed-arguments
// discriminated-narrowing tests below. Kept separate from the plain
// `weatherTool` in `vernLLM.tools.helpers.ts`, which stays un-narrowed on
// purpose for the other tools tests.
const getWeatherTyped = defineTool({
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  argumentsSchema: z.object({ city: z.string() }),
});

const cancelOrderTyped = defineTool({
  name: 'cancel_order',
  description: 'Cancels an order',
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
  },
  argumentsSchema: z.object({ orderId: z.string() }),
});

describe('typed arguments via defineTool()', () => {
  // Each test checks that `call.arguments` narrows to the right tool's
  // schema-inferred shape after a `call.name` check, for every entry point
  // that can resolve `CallWithToolsResult<T, Tools>`: call(), cachedCall(),
  // and a streaming call's `finalResult`. Only one tool actually fires at
  // runtime per test, both `name` branches are still written so both
  // narrowed shapes are checked by the compiler.

  it('call(): arguments narrows per tool after checking call.name', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      userContent: 'weather?',
      tools: [getWeatherTyped, cancelOrderTyped],
    });

    if (result.type === 'tool_calls') {
      const call = result.toolCalls[0]!;
      if (call.name === 'get_weather') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ city: string }>();
        expect(call.arguments.city).toBe('Boston');
      } else if (call.name === 'cancel_order') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ orderId: string }>();
      }
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('cachedCall(): arguments narrows per tool after checking call.name', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'cancel_order', arguments: { orderId: 'ord_42' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.cachedCall({
      cacheKey: 'typed-tools-1',
      ttl: 60,
      call: {
        userContent: 'cancel my order',
        tools: [getWeatherTyped, cancelOrderTyped],
      },
    });

    if (result.type === 'tool_calls') {
      const call = result.toolCalls[0]!;
      if (call.name === 'get_weather') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ city: string }>();
      } else if (call.name === 'cancel_order') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ orderId: string }>();
        expect(call.arguments.orderId).toBe('ord_42');
      }
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('call(): stream: true, finalResult narrows per tool the same way as the non-streaming result', async () => {
    const { client } = createMockStreamingClient([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          argumentsDelta: '{"city":"Boston"}',
          complete: true,
        },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'weather?',
      tools: [getWeatherTyped, cancelOrderTyped],
      stream: true,
    });
    await drain(chunks);
    const result = await finalResult;

    if (result.type === 'tool_calls') {
      const call = result.toolCalls[0]!;
      if (call.name === 'get_weather') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ city: string }>();
        expect(call.arguments.city).toBe('Boston');
      } else if (call.name === 'cancel_order') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ orderId: string }>();
      }
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('isToolCallResult<Tools>(): preserves per-tool argument narrowing on the conditional-tools path', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [getWeatherTyped, cancelOrderTyped] : undefined;

    const result = await llm.call({
      userContent: 'weather?',
      tools,
      jsonMode: true,
      schema: stringSchema,
    });

    // Tools inferred automatically from result's own static type, no
    // explicit type argument needed here since call()'s overload resolved
    // correctly (jsonMode + schema pinned T).
    if (isToolCallResult(result)) {
      const call = result.toolCalls[0]!;
      if (call.name === 'get_weather') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ city: string }>();
        expect(call.arguments.city).toBe('Boston');
      } else if (call.name === 'cancel_order') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ orderId: string }>();
      }
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('isToolCallResult<Tools>(): explicit type argument still overrides when result is not statically known', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const useTool = true;
    const tools = useTool ? [getWeatherTyped, cancelOrderTyped] : undefined;

    // `: CallParams<T>` annotation deliberately widens `tools` away before
    // `call()` sees it, matching the overload note's documented fallback
    // to plain `Promise<T>`, so `result`'s own static type carries no
    // `Tools` to infer from here, unlike the test above.
    const params: CallParams<string> = {
      userContent: 'weather?',
      tools,
      jsonMode: true,
      schema: stringSchema,
    };
    const result = await llm.call(params);

    if (isToolCallResult<typeof tools>(result)) {
      const call = result.toolCalls[0]!;
      if (call.name === 'get_weather') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ city: string }>();
        expect(call.arguments.city).toBe('Boston');
      } else if (call.name === 'cancel_order') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ orderId: string }>();
      }
    } else {
      throw new Error('expected a tool_calls result');
    }
  });

  it('call<T>(): pinning T explicitly alone loses Tools inference (TS generic inference limitation, not fixable per-overload)', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Boston' } }]),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const myTools = [getWeatherTyped, cancelOrderTyped];

    // Explicit `<string>` alone: TypeScript suppresses inference for every
    // subsequent type parameter once any leading one is explicit, `Tools`
    // included, so this genuinely resolves to the untyped default. Proven
    // directly here (rather than via `toEqualTypeOf`, which is stricter
    // than real assignability once `CallWithToolsResult` carries `Tools`
    // as a second parameter) by showing a tool-specific field access is a
    // real compile error, since `arguments` stayed `unknown`.
    const untyped = await llm.call<string>({
      userContent: 'weather?',
      tools: myTools,
      jsonMode: true,
      schema: stringSchema,
    });
    if (isToolCallResult(untyped)) {
      const call = untyped.toolCalls[0]!;
      expect(call.name).toBe('get_weather');
      // @ts-expect-error - arguments is `unknown` here, this is the bug this test documents
      void call.arguments.city;
    } else {
      throw new Error('expected a tool_calls result');
    }

    // Workaround: pass `Tools` explicitly too, restores narrowing.
    const typed = await llm.call<string, typeof myTools>({
      userContent: 'weather?',
      tools: myTools,
      jsonMode: true,
      schema: stringSchema,
    });
    if (typed.type === 'tool_calls') {
      const call = typed.toolCalls[0]!;
      if (call.name === 'get_weather') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ city: string }>();
        expect(call.arguments.city).toBe('Boston');
      } else if (call.name === 'cancel_order') {
        expectTypeOf(call.arguments).toEqualTypeOf<{ orderId: string }>();
      }
    } else {
      throw new Error('expected a tool_calls result');
    }
  });
});
