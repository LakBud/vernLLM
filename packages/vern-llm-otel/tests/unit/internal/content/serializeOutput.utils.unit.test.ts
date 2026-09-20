import { describe, expect, it, vi } from 'vitest';

import { serializeOutput } from '../../../../src/internal/content/serializeOutput.utils.js';
import { TRUNCATION_MARKER } from '../../../../src/internal/content/truncate.utils.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { CaptureContentOptions } from '../../../../src/types/index.js';
import type { ToolCallResult } from 'vern-llm';

function setup(options: CaptureContentOptions = {}) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const capture = normalizeOptions({ captureContent: options }).capture!;
  return { capture, logger, guard: createGuard(logger) };
}

const json = (value: string | undefined) => JSON.parse(value ?? 'null') as unknown;

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
