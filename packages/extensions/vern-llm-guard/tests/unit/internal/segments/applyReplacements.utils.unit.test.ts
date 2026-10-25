import { describe, expect, it } from 'vitest';

import { applyReplacements } from '../../../../src/internal/segments/applyReplacements.utils.js';
import { outputSegments } from '../../../../src/internal/segments/outputSegments.utils.js';
import { requestSegments } from '../../../../src/internal/segments/requestSegments.utils.js';

import type { WireMessage } from 'vern-llm';

const messages: WireMessage[] = [
  { role: 'system', content: 'be brief' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'and this' },
    ],
  },
  {
    role: 'assistant',
    content: 'checking',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"jane"}' } },
    ],
    thinking: [{ type: 'thinking', thinking: 'private', signature: 'sig' }],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'result text' },
  { role: 'user', content: 'thanks' },
];

describe('applyReplacements', () => {
  it('writes a replacement back exactly, and leaves the original alone', () => {
    const frozen = structuredClone(messages);
    const extracted = requestSegments(messages);
    const index = extracted.segments.findIndex((segment) => segment.text === 'and this');

    const result = applyReplacements(messages, extracted, [
      { segment: index, start: 4, end: 8, text: 'THAT' },
    ]);

    expect(result[1]).toMatchObject({
      content: [{ text: 'look at this' }, { type: 'image' }, { text: 'and THAT' }],
    });
    expect(messages).toEqual(frozen);
  });

  it('shares everything it did not change', () => {
    const extracted = requestSegments(messages);
    const result = applyReplacements(messages, extracted, [
      { segment: 0, start: 0, end: 2, text: 'do' },
    ]);

    expect(result).not.toBe(messages);
    expect((result[0] as { content: string }).content).toBe('do brief');
    for (const index of [1, 2, 3, 4]) expect(result[index]).toBe(messages[index]);
  });

  it('applies several replacements to one segment, in text order', () => {
    const extracted = outputSegments('a jane b bob c');
    const result = applyReplacements('a jane b bob c', extracted, [
      { segment: 0, start: 9, end: 12, text: '[N2]' },
      { segment: 0, start: 2, end: 6, text: '[N1]' },
    ]);
    expect(result).toBe('a [N1] b [N2] c');
  });

  it('drops a replacement that overlaps an earlier one', () => {
    const extracted = outputSegments('abcdef');
    const result = applyReplacements('abcdef', extracted, [
      { segment: 0, start: 1, end: 4, text: 'X' },
      { segment: 0, start: 3, end: 5, text: 'Y' },
    ]);
    expect(result).toBe('aXef');
  });

  it('writes into JSON values and tool call arguments', () => {
    const value = {
      type: 'tool_calls',
      toolCalls: [{ id: 'c', name: 'f', arguments: { to: 'jane@acme.com', n: 1 } }],
    };
    const extracted = outputSegments(value);
    const result = applyReplacements(value, extracted, [
      { segment: 0, start: 0, end: 13, text: 'x@redacted.invalid' },
    ]);
    expect(result.toolCalls[0]).toEqual({
      id: 'c',
      name: 'f',
      arguments: { to: 'x@redacted.invalid', n: 1 },
    });
    expect(value.toolCalls[0]!.arguments.to).toBe('jane@acme.com');
  });

  it('returns the same value when there is nothing to replace', () => {
    expect(applyReplacements(messages, requestSegments(messages), [])).toBe(messages);
  });

  it.each([
    ['a segment that does not exist', { segment: 9, start: 0, end: 1, text: 'x' }],
    ['a negative start', { segment: 0, start: -1, end: 1, text: 'x' }],
    ['an empty range', { segment: 0, start: 2, end: 2, text: 'x' }],
    ['an end past the text', { segment: 0, start: 0, end: 99, text: 'x' }],
    ['a fractional offset', { segment: 0, start: 0.5, end: 2, text: 'x' }],
  ])('throws for %s', (_name, replacement) => {
    expect(() => applyReplacements('short', outputSegments('short'), [replacement])).toThrow(
      RangeError,
    );
  });
});
