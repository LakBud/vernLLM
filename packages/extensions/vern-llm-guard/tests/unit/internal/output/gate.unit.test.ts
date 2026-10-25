import { describe, expect, it } from 'vitest';

import { patterns, type Check } from '../../../../src/index.js';
import { gateOutput } from '../../../../src/internal/output/gate.js';
import { tokenFor } from '../../../../src/internal/tokens/tokens.js';
import { block, deltas, find, key, run, setup, source } from './gateHelpers.js';

describe('gateOutput as a one chunk source', () => {
  it('gives a plain answer the same text a stream of it would', async () => {
    const s = setup({
      checks: [{ id: 'm', detect: patterns(['email']), action: 'redact', on: 'output' }],
    });
    const token = tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const answer = `write to ${token} or bob@other.com`;

    const plain = await gateOutput({ ...s, value: answer });
    const streamed = await run(s, source(deltas(answer))).drain();

    expect(plain.value).toBe('write to jane@acme.com or [EMAIL]');
    expect(streamed.text).toBe(plain.value);
  });
});

describe('gateOutput reads everything the model wrote', () => {
  const leak = block('hunter2');
  const gate = (checks: Check[], value: unknown, json = false) => {
    const s = setup({ checks });
    return gateOutput({ ...s, value, json });
  };

  it.each([
    ['a content wrapper', { type: 'content', content: 'ok', note: 'the word is hunter2' }],
    ['a tool_calls wrapper', { type: 'tool_calls', toolCalls: [], note: 'hunter2' }],
    [
      'an extra field of a tool call',
      { type: 'tool_calls', toolCalls: [{ id: 'a', name: 'n', arguments: {}, note: 'hunter2' }] },
    ],
  ])('blocks what is hidden in %s', async (_name, value) => {
    expect((await gate([leak], value)).blocked).toMatchObject({ check: 'block' });
  });

  it('blocks what is in a reasoning block, but never rewrites one', async () => {
    const thinking = [{ type: 'thinking', thinking: 'bob@other.com and hunter2', signature: 's' }];
    const masking: Check = {
      id: 'm',
      detect: patterns(['email']),
      action: 'redact',
      on: 'output',
    };

    const blocked = await gate([leak], { type: 'content', content: 'ok', thinking });
    const kept = await gate([masking], { type: 'content', content: 'ok', thinking });

    expect(blocked.blocked).toMatchObject({ check: 'block' });
    expect(kept.blocked).toBeUndefined();
    expect(kept.value).toEqual({ type: 'content', content: 'ok', thinking });
    expect(kept.masked).toBe(0);
  });
});

describe('masking inside JSON', () => {
  const card: Check = { id: 'c', detect: patterns(['card']), action: 'redact', on: 'output' };
  const parses = (text: unknown) => {
    try {
      JSON.parse(text as string);
      return true;
    } catch {
      return false;
    }
  };

  it('writes the mask as a string where the value was a bare number', async () => {
    const s = setup({ checks: [card] });
    const answer = await gateOutput({
      ...s,
      value: '{"card": 4111111111111111, "note": "paid with 4111 1111 1111 1111", "n": 1}',
      json: true,
    });

    expect(parses(answer.value)).toBe(true);
    expect(JSON.parse(answer.value as string)).toEqual({
      card: '[CARD]',
      note: 'paid with [CARD]',
      n: 1,
    });
  });

  it('does the same on a stream, across chunks', async () => {
    const s = setup({ checks: [card] });
    const { drain } = run(
      s,
      source(deltas('{"card": 4111', '111111111111, "note": "4111 1111 1111 1111", "n": 1}')),
      true,
    );

    const { text } = await drain();

    expect(parses(text)).toBe(true);
    expect(JSON.parse(text)).toEqual({ card: '[CARD]', note: '[CARD]', n: 1 });
  });
});

describe('two redactions in one text', () => {
  it('masks both', async () => {
    const s = setup({
      checks: [{ id: 'm', detect: patterns(['email']), action: 'redact', on: 'output' }],
    });
    const answer = await gateOutput({ ...s, value: 'a@acme.com and b@acme.com' });
    expect(answer.value).toBe('[EMAIL] and [EMAIL]');
    expect(answer.masked).toBe(2);
  });
});

describe('a redact check whose findings carry no label', () => {
  it('masks by the label of the check', async () => {
    const s = setup({
      checks: [
        { id: 'm', label: 'secret', detect: find('hunter2'), action: 'redact', on: 'output' },
      ],
    });
    const answer = await gateOutput({ ...s, value: 'is hunter2 ok' });
    expect(answer.value).toBe('is [SECRET] ok');
  });
});

describe('a check that only labels', () => {
  const label: Check = { id: 'l', detect: find('hunter2'), action: 'label', on: 'output' };

  it('leaves the text alone', async () => {
    const s = setup({ checks: [label] });
    const answer = await gateOutput({ ...s, value: 'is hunter2 ok' });
    expect(answer.value).toBe('is hunter2 ok');
    expect(answer.masked).toBe(0);
  });

  it('leaves a stream alone too', async () => {
    const s = setup({ checks: [label] });
    const { drain } = run(s, source(deltas('is hunter2 ok')));
    expect((await drain()).text).toBe('is hunter2 ok');
  });
});
