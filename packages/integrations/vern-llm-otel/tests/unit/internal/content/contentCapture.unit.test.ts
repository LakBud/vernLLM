import { describe, expect, it, vi } from 'vitest';

import { createContentCapture } from '../../../../src/internal/content/contentCapture.utils.js';
import { serializeOutput } from '../../../../src/internal/content/serializeOutput.utils.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { CaptureContentOptions } from '../../../../src/types/index.js';
import type { Span } from '@opentelemetry/api';
import type { PreDispatchContext, WireCallRequest, WireMessage, WireTool } from 'vern-llm';

function setup(options: CaptureContentOptions = {}) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const capture = normalizeOptions({ captureContent: options }).capture!;
  return { capture, logger, guard: createGuard(logger) };
}

const request = (
  messages: WireMessage[],
  extra: Partial<WireCallRequest> = {},
): WireCallRequest => ({ model: 'gpt-4o', max_tokens: 100, messages, ...extra });

const tool = (
  name: string,
  parameters: Record<string, unknown> = { type: 'object' },
): WireTool => ({
  type: 'function',
  function: { name, description: `does ${name}`, parameters },
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
