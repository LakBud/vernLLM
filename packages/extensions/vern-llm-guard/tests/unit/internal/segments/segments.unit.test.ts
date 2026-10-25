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

describe('requestSegments', () => {
  it('cuts every role into segments, with the role as the source', () => {
    const { segments, unscanned } = requestSegments(messages);

    expect(segments).toEqual([
      { text: 'be brief', source: 'system' },
      { text: 'look at this', source: 'user' },
      { text: 'and this', source: 'user' },
      { text: 'checking', source: 'assistant' },
      { text: '{"q":"jane"}', source: 'assistant' },
      { text: 'result text', source: 'tool' },
      { text: 'thanks', source: 'user' },
    ]);
    expect(unscanned).toBe(1);
  });

  it('never reads thinking blocks, ids or tool names', () => {
    const texts = requestSegments(messages).segments.map((segment) => segment.text);
    for (const hidden of ['private', 'sig', 'c1', 'lookup']) expect(texts).not.toContain(hidden);
  });

  it('counts malformed content as unscanned', () => {
    const bad = [
      { role: 'system', content: 42 },
      { role: 'user', content: { not: 'text' } },
      { role: 'tool', tool_call_id: 'c', content: null },
    ] as unknown as WireMessage[];
    const { segments, unscanned } = requestSegments(bad);
    expect(segments).toEqual([]);
    expect(unscanned).toBe(3);
  });

  it('skips empty text and an assistant turn with only tool calls', () => {
    const { segments } = requestSegments([
      { role: 'user', content: '' },
      { role: 'assistant', tool_calls: [] },
    ]);
    expect(segments).toEqual([]);
  });
});

describe('outputSegments', () => {
  it('reads plain text', () => {
    expect(outputSegments('hello').segments).toEqual([{ text: 'hello', source: 'output' }]);
  });

  it('reads the strings of a parsed JSON answer, nested, but not numbers or keys', () => {
    const { segments, paths } = outputSegments({
      name: 'Jane',
      tags: ['a', { note: 'b' }],
      age: 41,
      ok: true,
      nothing: null,
    });
    expect(segments.map((segment) => segment.text)).toEqual(['Jane', 'a', 'b']);
    expect(paths[2]).toEqual(['tags', 1, 'note']);
  });

  it('reads through a content wrapper', () => {
    const { segments, paths } = outputSegments({ type: 'content', content: { summary: 'hi' } });
    expect(segments).toEqual([{ text: 'hi', source: 'output' }]);
    expect(paths[0]).toEqual(['content', 'summary']);
  });

  it('reads the text and arguments of tool calls, never their ids, names or the wrapper type', () => {
    const { segments } = outputSegments({
      type: 'tool_calls',
      content: 'let me look',
      toolCalls: [
        { id: 'call-1', name: 'lookup', arguments: { who: 'jane', nested: { n: ['x'] } } },
      ],
    });
    expect(segments.map((segment) => segment.text)).toEqual(['let me look', 'jane', 'x']);
  });

  it('scans reasoning blocks but marks them fixed, so they are never rewritten', () => {
    const { segments, fixed } = outputSegments({
      type: 'content',
      content: 'answer',
      thinking: [{ type: 'thinking', thinking: 'private', signature: 'sig' }],
    });
    expect(segments.map((segment) => segment.text)).toEqual([
      'answer',
      'thinking',
      'private',
      'sig',
    ]);
    expect(fixed).toEqual([false, true, true, true]);
  });

  it.each([
    ['a content wrapper', { type: 'content', content: 'ok', note: 'hidden' }],
    ['a tool_calls wrapper', { type: 'tool_calls', toolCalls: [], note: 'hidden' }],
    [
      'an extra field on a tool call',
      { type: 'tool_calls', toolCalls: [{ id: 'a', name: 'n', arguments: {}, note: 'hidden' }] },
    ],
    ['a plain object', { note: 'hidden' }],
  ])('reads every other key of %s, because in JSON mode the model wrote it all', (_name, value) => {
    expect(outputSegments(value).segments.map((segment) => segment.text)).toContain('hidden');
  });

  it('reads tool calls that are not objects as plain data', () => {
    const { segments } = outputSegments({
      type: 'tool_calls',
      toolCalls: ['loose', ['nested'], null],
    });
    expect(segments.map((segment) => segment.text)).toEqual(['loose', 'nested']);
  });

  it('counts a value nested too deep as unscanned instead of recursing forever', () => {
    let deep: unknown = 'bottom';
    for (let level = 0; level < 200; level++) deep = { next: deep };
    const { segments, unscanned } = outputSegments(deep);
    expect(segments).toEqual([]);
    expect(unscanned).toBe(1);
  });

  it('ignores values that are not plain data', () => {
    expect(outputSegments({ when: new Date(), run: () => 'x' }).segments).toEqual([]);
  });
});

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
