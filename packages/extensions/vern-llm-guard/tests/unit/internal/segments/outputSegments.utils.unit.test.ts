import { describe, expect, it } from 'vitest';

import { outputSegments } from '../../../../src/internal/segments/outputSegments.utils.js';

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
