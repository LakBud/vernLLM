import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_PLACEHOLDER,
  serializeInput,
} from '../../../../src/internal/content/serializeInput.utils.js';
import { TRUNCATION_MARKER } from '../../../../src/internal/content/truncate.utils.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { CaptureContentOptions } from '../../../../src/types/index.js';
import type { WireCallRequest, WireMessage, WireTool } from 'vern-llm';

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
