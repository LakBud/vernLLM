import { describe, expect, it, vi } from 'vitest';

import {
  createContentCapture,
  decideCapture,
  IMAGE_PLACEHOLDER,
  serializeInput,
  serializeOutput,
  TRUNCATION_MARKER,
  truncate,
} from '../../src/content.js';
import { createGuard } from '../../src/guard.js';
import { normalizeOptions, type CaptureContentOptions } from '../../src/options.js';

import type { Span } from '@opentelemetry/api';
import type {
  PreDispatchContext,
  ToolCallResult,
  WireCallRequest,
  WireMessage,
  WireTool,
} from 'vern-llm';

function setup(options: CaptureContentOptions = {}) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const capture = normalizeOptions({ captureContent: options }).capture!;
  return { capture, logger, guard: createGuard(logger) };
}

const request = (
  messages: WireMessage[],
  extra: Partial<WireCallRequest> = {},
): WireCallRequest => ({ model: 'gpt-4o', max_tokens: 100, messages, ...extra });

const json = (value: string | undefined) => JSON.parse(value ?? 'null') as unknown;

const tool = (
  name: string,
  parameters: Record<string, unknown> = { type: 'object' },
): WireTool => ({
  type: 'function',
  function: { name, description: `does ${name}`, parameters },
});

describe('truncate', () => {
  it('returns text that fits untouched, with no marker', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello', 100)).toBe('hello');
    expect(truncate('hello', Number.POSITIVE_INFINITY)).toBe('hello');
    expect(truncate('', 0)).toBe('');
  });

  it('cuts to the limit and marks it', () => {
    expect(truncate('abcdef', 3)).toBe(`abc${TRUNCATION_MARKER}`);
  });

  it('leaves only the marker when nothing is allowed', () => {
    expect(truncate('abc', 0)).toBe(TRUNCATION_MARKER);
  });

  it('never splits a surrogate pair', () => {
    // Each emoji is two UTF-16 units, so a cut at 3 would land between the halves of the second.
    const cut = truncate('😀😀😀', 3);

    expect(cut).toBe(`😀${TRUNCATION_MARKER}`);
    expect(cut.startsWith('\ud83d\ude00')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut.replace(TRUNCATION_MARKER, ''))).toBe(
      false,
    );
  });

  it('keeps a whole pair when the cut falls after it', () => {
    expect(truncate('😀😀😀', 4)).toBe(`😀😀${TRUNCATION_MARKER}`);
  });

  it('drops the only pair when a limit of 1 would split it', () => {
    expect(truncate('😀', 0)).toBe(TRUNCATION_MARKER);
    expect(truncate('😀😀', 1)).toBe(TRUNCATION_MARKER);
  });
});

describe('serializeInput', () => {
  it('turns system messages into system instructions and the rest into input messages', () => {
    const { capture, guard } = setup();
    const out = serializeInput(
      request([
        { role: 'system', content: 'be brief' },
        { role: 'system', content: 'be kind' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
      capture,
      guard,
    );

    expect(json(out.systemInstructions)).toEqual([
      { type: 'text', content: 'be brief' },
      { type: 'text', content: 'be kind' },
    ]);
    expect(json(out.inputMessages)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
    expect(out.toolDefinitions).toBeUndefined();
  });

  it('keeps message order', () => {
    const { capture, guard } = setup();
    const out = serializeInput(
      request([
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ]),
      capture,
      guard,
    );

    const texts = (json(out.inputMessages) as { parts: { content: string }[] }[]).map(
      (message) => message.parts[0]!.content,
    );
    expect(texts).toEqual(['one', 'two', 'three']);
  });

  it('records images as a placeholder and never their bytes', () => {
    const { capture, guard } = setup();
    const secretBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const out = serializeInput(
      request([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', data: secretBytes, mimeType: 'image/png' },
          ],
        },
      ]),
      capture,
      guard,
    );

    expect(json(out.inputMessages)).toEqual([
      {
        role: 'user',
        parts: [
          { type: 'text', content: 'what is this' },
          { type: 'text', content: IMAGE_PLACEHOLDER },
        ],
      },
    ]);
    expect(out.inputMessages).not.toContain(secretBytes);
  });

  it('maps assistant tool calls with parsed arguments, and keeps unparsable ones as text', () => {
    const { capture, guard } = setup();
    const out = serializeInput(
      request([
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Oslo"}' },
            },
            { id: 'c2', type: 'function', function: { name: 'broken', arguments: '{"city":' } },
            { id: 'c3', type: 'function', function: { name: 'empty', arguments: '' } },
          ],
        },
      ]),
      capture,
      guard,
    );

    expect(json(out.inputMessages)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'checking' },
          { type: 'tool_call', id: 'c1', name: 'weather', arguments: { city: 'Oslo' } },
          { type: 'tool_call', id: 'c2', name: 'broken', arguments: '{"city":' },
          { type: 'tool_call', id: 'c3', name: 'empty', arguments: '' },
        ],
      },
    ]);
  });

  it('keeps an assistant message that has neither text nor calls, with no parts', () => {
    const { capture, guard } = setup();
    const out = serializeInput(request([{ role: 'assistant' }]), capture, guard);
    expect(json(out.inputMessages)).toEqual([{ role: 'assistant', parts: [] }]);
  });

  it('maps a tool result to a tool call response', () => {
    const { capture, guard } = setup();
    const out = serializeInput(
      request([{ role: 'tool', tool_call_id: 'c1', content: 'rainy, 57F' }]),
      capture,
      guard,
    );

    expect(json(out.inputMessages)).toEqual([
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'c1', response: 'rainy, 57F' }] },
    ]);
  });

  it('skips empty text pieces', () => {
    const { capture, guard } = setup();
    const out = serializeInput(request([{ role: 'user', content: '' }]), capture, guard);
    expect(json(out.inputMessages)).toEqual([{ role: 'user', parts: [] }]);
  });

  describe('groups', () => {
    const messages: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];

    it('input: false leaves out the messages only', () => {
      const { capture, guard } = setup({ input: false });
      const out = serializeInput(request(messages), capture, guard);
      expect(out.inputMessages).toBeUndefined();
      expect(out.systemInstructions).toBeDefined();
    });

    it('systemInstructions: false drops system messages and does not move them into the input', () => {
      const { capture, guard } = setup({ systemInstructions: false });
      const out = serializeInput(request(messages), capture, guard);

      expect(out.systemInstructions).toBeUndefined();
      expect(out.inputMessages).not.toContain('sys');
    });

    it('omits an attribute that would be empty', () => {
      const { capture, guard } = setup();
      const out = serializeInput(request([{ role: 'user', content: 'hi' }]), capture, guard);
      expect(out.systemInstructions).toBeUndefined();

      const none = serializeInput(request([]), capture, guard);
      expect(none).toEqual({});
    });

    it('tool definitions are off by default and included when asked', () => {
      const withTools = request(messages, { tools: [tool('weather')] });

      expect(
        serializeInput(withTools, setup().capture, setup().guard).toolDefinitions,
      ).toBeUndefined();

      const { capture, guard } = setup({ toolDefinitions: true });
      expect(json(serializeInput(withTools, capture, guard).toolDefinitions)).toEqual([
        {
          type: 'function',
          name: 'weather',
          description: 'does weather',
          parameters: { type: 'object' },
        },
      ]);
    });

    it('records no tool definitions when there are no tools', () => {
      const { capture, guard } = setup({ toolDefinitions: true });
      expect(serializeInput(request(messages), capture, guard).toolDefinitions).toBeUndefined();
      expect(
        serializeInput(request(messages, { tools: [] }), capture, guard).toolDefinitions,
      ).toBeUndefined();
    });
  });

  describe('length budget', () => {
    it('spends the allowance on the newest messages first', () => {
      const { capture, guard } = setup({ maxLength: 20 });
      const out = serializeInput(
        request([
          { role: 'user', content: 'a'.repeat(20) },
          { role: 'user', content: 'b'.repeat(10) },
        ]),
        capture,
        guard,
      );

      const contents = (json(out.inputMessages) as { parts: { content: string }[] }[]).map(
        (message) => message.parts[0]!.content,
      );
      expect(contents).toEqual(['a'.repeat(10) + TRUNCATION_MARKER, 'b'.repeat(10)]);
    });

    it('leaves later pieces as a bare marker once the allowance is spent', () => {
      const { capture, guard } = setup({ maxLength: 5 });
      const out = serializeInput(
        request([
          { role: 'user', content: 'older' },
          { role: 'user', content: 'newer' },
        ]),
        capture,
        guard,
      );

      const contents = (json(out.inputMessages) as { parts: { content: string }[] }[]).map(
        (message) => message.parts[0]!.content,
      );
      expect(contents).toEqual([TRUNCATION_MARKER, 'newer']);
    });

    it('gives each attribute its own allowance', () => {
      const { capture, guard } = setup({ maxLength: 4 });
      const out = serializeInput(
        request([
          { role: 'system', content: 'abcd' },
          { role: 'user', content: 'wxyz' },
        ]),
        capture,
        guard,
      );

      expect(out.systemInstructions).not.toContain('truncated');
      expect(out.inputMessages).not.toContain('truncated');
    });

    it('shares one allowance across several system messages', () => {
      const { capture, guard } = setup({ maxLength: 6 });
      const out = serializeInput(
        request([
          { role: 'system', content: 'abcd' },
          { role: 'system', content: 'efgh' },
        ]),
        capture,
        guard,
      );

      expect(json(out.systemInstructions)).toEqual([
        { type: 'text', content: 'abcd' },
        { type: 'text', content: `ef${TRUNCATION_MARKER}` },
      ]);
    });

    it('applies to tool call arguments, which then stay a string', () => {
      const { capture, guard } = setup({ maxLength: 6 });
      const out = serializeInput(
        request([
          {
            role: 'assistant',
            tool_calls: [
              { id: 'c', type: 'function', function: { name: 'f', arguments: '{"city":"Oslo"}' } },
            ],
          },
        ]),
        capture,
        guard,
      );

      const [message] = json(out.inputMessages) as { parts: { arguments: unknown }[] }[];
      expect(message!.parts[0]!.arguments).toBe(`{"city${TRUNCATION_MARKER}`);
    });

    it('does not truncate at all for an infinite limit', () => {
      const { capture, guard } = setup({ maxLength: Number.POSITIVE_INFINITY });
      const big = 'x'.repeat(200_000);
      const out = serializeInput(request([{ role: 'user', content: big }]), capture, guard);

      expect(out.inputMessages).not.toContain('truncated');
      expect(out.inputMessages!.length).toBeGreaterThan(200_000);
    });

    it('bounds a huge history', () => {
      const { capture, guard } = setup({ maxLength: 1000 });
      const messages = Array.from({ length: 500 }, (_, index) => ({
        role: 'user' as const,
        content: `message ${index} ${'y'.repeat(200)}`,
      }));

      const out = serializeInput(request(messages), capture, guard);
      const parts = (json(out.inputMessages) as { parts: { content: string }[] }[]).flatMap(
        (message) => message.parts.map((part) => part.content),
      );

      expect(parts.join('').replaceAll(TRUNCATION_MARKER, '').length).toBeLessThanOrEqual(1000);
      expect(parts.at(-1)).toContain('message 499');
    });
  });

  describe('tool definition size', () => {
    it('falls back to name only when the full definitions are too large', () => {
      const big = { type: 'object', description: 'z'.repeat(500) };
      const { capture, guard } = setup({ toolDefinitions: true, maxLength: 200 });
      const out = serializeInput(
        request([{ role: 'user', content: 'hi' }], { tools: [tool('a', big), tool('b', big)] }),
        capture,
        guard,
      );

      expect(json(out.toolDefinitions)).toEqual([
        { type: 'function', name: 'a' },
        { type: 'function', name: 'b' },
      ]);
    });

    it('leaves the attribute out when even the names do not fit', () => {
      const { capture, guard } = setup({ toolDefinitions: true, maxLength: 10 });
      const out = serializeInput(
        request([{ role: 'user', content: 'hi' }], { tools: [tool('a_long_tool_name')] }),
        capture,
        guard,
      );

      expect(out.toolDefinitions).toBeUndefined();
    });

    it('survives a schema that cannot be serialized', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const { capture, guard } = setup({ toolDefinitions: true });
      const out = serializeInput(
        request([{ role: 'user', content: 'hi' }], { tools: [tool('a', cyclic)] }),
        capture,
        guard,
      );

      expect(json(out.toolDefinitions)).toEqual([{ type: 'function', name: 'a' }]);
    });
  });

  describe('redact', () => {
    const secretRequest = request([
      { role: 'system', content: 'sys SECRET' },
      { role: 'user', content: 'user SECRET' },
      {
        role: 'assistant',
        content: 'assistant SECRET',
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'f', arguments: '{"k":"SECRET"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c', content: 'tool SECRET' },
    ]);

    it('runs on every text piece, including tool arguments and tool results', () => {
      const { capture, guard } = setup({ redact: (text) => text.replaceAll('SECRET', '***') });
      const out = serializeInput(secretRequest, capture, guard);

      expect(JSON.stringify(out)).not.toContain('SECRET');
      expect(out.inputMessages).toContain('user ***');
      expect(out.inputMessages).toContain('"k":"***"');
      expect(out.inputMessages).toContain('tool ***');
      expect(out.systemInstructions).toContain('sys ***');
    });

    it('runs before truncation, so the limit applies to what is actually recorded', () => {
      const { capture, guard } = setup({ maxLength: 10, redact: () => 'X'.repeat(50) });
      const out = serializeInput(request([{ role: 'user', content: 'hi' }]), capture, guard);

      expect(json(out.inputMessages)).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'X'.repeat(10) + TRUNCATION_MARKER }] },
      ]);
    });

    it('drops a piece whose redactor throws, and never leaks the original', () => {
      const { capture, guard, logger } = setup({
        redact: () => {
          throw new Error('redactor down');
        },
      });
      const out = serializeInput(secretRequest, capture, guard);

      expect(JSON.stringify(out)).not.toContain('SECRET');
      expect(json(out.inputMessages)).toEqual([
        { role: 'user', parts: [] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'c', name: 'f' }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'c' }] },
      ]);
      expect(logger.error).toHaveBeenCalledWith(
        '[VernLLM] otel: captureContent.redact failed',
        expect.objectContaining({ message: 'redactor down' }),
      );
    });

    it.each([undefined, null, 42, {}, ['x']])(
      'drops a piece when the redactor returns %j',
      (value) => {
        const { capture, guard } = setup({ redact: () => value as never });
        const out = serializeInput(secretRequest, capture, guard);

        expect(JSON.stringify(out)).not.toContain('SECRET');
        expect(out.systemInstructions).toBeUndefined();
      },
    );
  });
});

describe('serializeOutput', () => {
  it('records a string as one assistant text part with an inferred stop', () => {
    const { capture, guard } = setup();
    expect(json(serializeOutput('the answer', capture, guard))).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'the answer' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('records a parsed JSON result as its JSON text', () => {
    const { capture, guard } = setup();
    const out = json(serializeOutput({ city: 'Oslo', n: 2 }, capture, guard)) as {
      parts: { content: string }[];
    }[];

    expect(JSON.parse(out[0]!.parts[0]!.content)).toEqual({ city: 'Oslo', n: 2 });
  });

  it('unwraps the content wrapper a tools enabled call adds', () => {
    const { capture, guard } = setup();
    const out = json(serializeOutput({ type: 'content', content: 'plain' }, capture, guard)) as {
      parts: unknown[];
    }[];

    expect(out[0]!.parts).toEqual([{ type: 'text', content: 'plain' }]);
  });

  it('records a tool call result as tool call parts with a tool_call finish', () => {
    const { capture, guard } = setup();
    const result: ToolCallResult = {
      type: 'tool_calls',
      content: 'let me check',
      toolCalls: [{ id: 'c1', name: 'weather', arguments: { city: 'Oslo' } }],
    };

    expect(json(serializeOutput(result, capture, guard))).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'let me check' },
          { type: 'tool_call', id: 'c1', name: 'weather', arguments: { city: 'Oslo' } },
        ],
        finish_reason: 'tool_call',
      },
    ]);
  });

  it('omits arguments that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { capture, guard } = setup();

    const out = json(
      serializeOutput(
        { type: 'tool_calls', toolCalls: [{ id: 'c', name: 'f', arguments: cyclic }] },
        capture,
        guard,
      ),
    ) as { parts: unknown[] }[];

    expect(out[0]!.parts).toEqual([{ type: 'tool_call', id: 'c', name: 'f' }]);
  });

  it.each([
    [
      'a cyclic object',
      (() => {
        const o: Record<string, unknown> = {};
        o.o = o;
        return o;
      })(),
    ],
    ['a BigInt', 10n],
    ['undefined', undefined],
    ['a function', () => 1],
  ])('marks %s as unserializable instead of throwing', (_label, value) => {
    const { capture, guard } = setup();
    expect(json(serializeOutput(value, capture, guard))).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: '[unserializable output]' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('records null as the text null', () => {
    const { capture, guard } = setup();
    const out = json(serializeOutput(null, capture, guard)) as { parts: { content: string }[] }[];
    expect(out[0]!.parts[0]!.content).toBe('null');
  });

  it('keeps the message with no parts for an empty string', () => {
    const { capture, guard } = setup();
    expect(json(serializeOutput('', capture, guard))).toEqual([
      { role: 'assistant', parts: [], finish_reason: 'stop' },
    ]);
  });

  it('applies redact and the length limit', () => {
    const { capture, guard } = setup({
      maxLength: 8,
      redact: (text) => text.replaceAll('SECRET', '***'),
    });
    const out = serializeOutput('SECRET and more text', capture, guard);

    expect(out).not.toContain('SECRET');
    expect(out).toContain(`*** and ${TRUNCATION_MARKER}`);
  });

  it('drops the text when the redactor throws', () => {
    const { capture, guard } = setup({
      redact: () => {
        throw new Error('nope');
      },
    });
    const out = serializeOutput('SECRET', capture, guard);

    expect(out).not.toContain('SECRET');
    expect(json(out)).toEqual([{ role: 'assistant', parts: [], finish_reason: 'stop' }]);
  });
});

describe('decideCapture', () => {
  const ctx = { requestId: 'r' } as PreDispatchContext;
  const req = request([{ role: 'user', content: 'hi' }]);
  const spanOf = (recording: boolean) => ({ isRecording: () => recording }) as unknown as Span;

  it('captures when nothing gates it', () => {
    const { capture, guard } = setup();
    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(true);
  });

  it('does not run user code when no group is enabled', () => {
    const when = vi.fn(() => true);
    const { capture, guard } = setup({
      input: false,
      output: false,
      systemInstructions: false,
      when,
    });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    expect(when).not.toHaveBeenCalled();
  });

  it('does not run user code when the span is not recording', () => {
    const when = vi.fn(() => true);
    const { capture, guard } = setup({ when });

    expect(decideCapture(capture, ctx, req, spanOf(false), guard)).toBe(false);
    expect(when).not.toHaveBeenCalled();
  });

  it('gives the callback the context and the request it was asked about', () => {
    const when = vi.fn((_ctx: PreDispatchContext, _request: Readonly<WireCallRequest>) => true);
    const { capture, guard } = setup({ when });

    decideCapture(capture, ctx, req, spanOf(true), guard);

    expect(when).toHaveBeenCalledTimes(1);
    expect(when.mock.calls[0]?.[0]).toBe(ctx);
    expect(when.mock.calls[0]?.[1]).toBe(req);
  });

  it('captures only for exactly true', () => {
    expect(
      decideCapture(setup({ when: () => true }).capture, ctx, req, spanOf(true), setup().guard),
    ).toBe(true);
    expect(
      decideCapture(setup({ when: () => false }).capture, ctx, req, spanOf(true), setup().guard),
    ).toBe(false);
  });

  it.each(['yes', 'true', 1, {}, [], null, undefined])('treats %j as no', (value) => {
    const { capture, guard, logger } = setup({ when: () => value as never });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails closed and logs once when the callback throws', () => {
    const { capture, guard, logger } = setup({
      when: () => {
        throw new Error('policy service down');
      },
    });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: captureContent.when failed',
      expect.objectContaining({ message: 'policy service down' }),
    );
  });

  it('refuses and logs once when the callback returns a promise, even a resolved true', async () => {
    const { capture, guard, logger } = setup({ when: (() => Promise.resolve(true)) as never });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: captureContent.when failed',
      expect.objectContaining({ message: expect.stringContaining('promise') }),
    );
  });

  it('does not leave an unhandled rejection behind when the promise rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const { capture, guard } = setup({
        when: (() => Promise.reject(new Error('async policy failure'))) as never,
      });

      expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('refuses a thenable that throws when observed', () => {
    const hostile = {
      get then(): never {
        throw new Error('hostile getter');
      },
    };
    const { capture, guard } = setup({ when: (() => hostile) as never });

    expect(decideCapture(capture, ctx, req, spanOf(true), guard)).toBe(false);
  });
});

describe('createContentCapture', () => {
  const fakeSpan = (recording = true) => {
    const setAttributes = vi.fn();
    const setAttribute = vi.fn();
    const span = { isRecording: () => recording, setAttributes, setAttribute } as unknown as Span;
    return { span, setAttributes, setAttribute };
  };

  const req = request(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    { tools: [tool('weather')] },
  );

  it('writes the enabled input attributes to the attempt span', () => {
    const { capture, guard } = setup({ toolDefinitions: true });
    const { span, setAttributes } = fakeSpan();

    createContentCapture(capture, guard).captureInput(span, req);

    const written = setAttributes.mock.calls[0]![0] as Record<string, string>;
    expect(Object.keys(written).sort()).toEqual([
      'gen_ai.input.messages',
      'gen_ai.system_instructions',
      'gen_ai.tool.definitions',
    ]);
  });

  it('writes nothing to a span that is not recording', () => {
    const { capture, guard } = setup();
    const { span, setAttributes, setAttribute } = fakeSpan(false);
    const content = createContentCapture(capture, guard);

    content.captureInput(span, req);
    content.captureOutput(span, 'answer');

    expect(setAttributes).not.toHaveBeenCalled();
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it('writes the output, unless the output group is off', () => {
    const on = fakeSpan();
    createContentCapture(setup().capture, setup().guard).captureOutput(on.span, 'answer');
    expect(on.setAttribute).toHaveBeenCalledWith('gen_ai.output.messages', expect.any(String));

    const off = fakeSpan();
    createContentCapture(setup({ output: false }).capture, setup().guard).captureOutput(
      off.span,
      'answer',
    );
    expect(off.setAttribute).not.toHaveBeenCalled();
  });

  it('writes only the attributes that have content', () => {
    const { capture, guard } = setup();
    const { span, setAttributes } = fakeSpan();

    createContentCapture(capture, guard).captureInput(
      span,
      request([{ role: 'system', content: 'only a system prompt' }]),
    );

    expect(Object.keys(setAttributes.mock.calls[0]![0] as object)).toEqual([
      'gen_ai.system_instructions',
    ]);
  });

  it('writes no output attribute when the output cannot be serialized at all', () => {
    const { capture, guard } = setup();
    const { span, setAttribute } = fakeSpan();
    const unserializable = {
      type: 'tool_calls',
      toolCalls: [{ id: 10n, name: 'f', arguments: {} }],
    };

    createContentCapture(capture, guard).captureOutput(span, unserializable);

    expect(serializeOutput(unserializable, capture, guard)).toBeUndefined();
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it('decides through decideCapture', () => {
    const { capture, guard } = setup({ when: () => true });
    const { span } = fakeSpan();

    expect(createContentCapture(capture, guard).decide({} as PreDispatchContext, req, span)).toBe(
      true,
    );
  });
});
