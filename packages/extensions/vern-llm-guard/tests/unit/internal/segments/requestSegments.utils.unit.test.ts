import { describe, expect, it } from 'vitest';

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
