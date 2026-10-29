import { describe, expect, it } from 'vitest';

import {
  captureLogger,
  classifierAnswer,
  classifierInput,
  classifierResponder,
  createClassifierLLM,
  createModerationClient,
  createStreamClient,
  lastUserText,
  moderationResult,
  textDeltas,
  type CreateParams,
  type Found,
} from '../helpers.js';

const params = (messages: CreateParams['messages']): CreateParams =>
  ({ model: 'm', max_tokens: 1, messages }) as CreateParams;

describe('test helpers', () => {
  it('reads the last user message, text blocks only, or nothing', () => {
    expect(lastUserText(params([{ role: 'system', content: 's' }]))).toBe('');
    expect(
      lastUserText(
        params([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a' },
              { type: 'image', data: 'x', mimeType: 'image/png' },
              { type: 'text', text: 'b' },
            ],
          },
        ]),
      ),
    ).toBe('ab');
  });

  it('splits text into pieces, and does not add an empty rest', () => {
    expect(textDeltas('abcd', 2)).toHaveLength(2);
    expect(textDeltas('ab', 2)).toEqual([{ type: 'text-delta', delta: 'ab' }]);
  });

  it('records everything the logger is given, including debug lines', () => {
    const log = captureLogger();
    log.logger.debug('d extra');
    expect(log.everything()).toContain('extra');
  });

  it('refuses a plain call on a stream only client', async () => {
    const { client } = createStreamClient([]);
    await expect(
      client.chat.completions.create(params([]) as never, { signal: new AbortController().signal }),
    ).rejects.toThrow(/only streams/);
  });

  it('scores moderation results, flagging a category from 0.5', () => {
    expect(moderationResult().flagged).toBe(false);
    const result = moderationResult({ violence: 0.7, hate: 0.2 });
    expect(result).toMatchObject({
      flagged: true,
      categories: { violence: true, hate: false },
      category_scores: { violence: 0.7, hate: 0.2 },
    });
  });

  it('answers a moderation request per text, and works without request options', async () => {
    const { client, calls, peak } = createModerationClient((text) =>
      text === 'bad' ? { violence: 1 } : {},
    );

    const answer = await client.moderations.create({ model: 'm', input: ['bad', 'fine'] });

    expect(answer.results.map((result) => result.flagged)).toEqual([true, false]);
    expect(calls).toEqual([{ model: 'm', input: ['bad', 'fine'], signal: undefined }]);
    expect(peak()).toBe(1);
  });

  it('can answer late, stop on abort or fail', async () => {
    const slow = createModerationClient(undefined, { delayMs: 5 });
    await expect(
      slow.client.moderations.create({ model: 'm', input: ['a'] }),
    ).resolves.toBeTruthy();

    const controller = new AbortController();
    const aborted = slow.client.moderations.create(
      { model: 'm', input: ['a'] },
      { signal: controller.signal },
    );
    controller.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');

    const failing = createModerationClient(undefined, { error: new Error('down') });
    await expect(failing.client.moderations.create({ model: 'm', input: ['a'] })).rejects.toThrow(
      'down',
    );
  });

  describe('the classifier stub', () => {
    const content =
      '<t_0a1b2c id="0">\nfirst\n</t_0a1b2c>\n<t_0a1b2c id="1">\ntwo\nlines\n</t_0a1b2c>';

    it('reads the boundary and the texts of a call, by id', () => {
      expect(classifierInput(content)).toEqual({
        boundary: 't_0a1b2c',
        texts: ['first', 'two\nlines'],
      });
      expect(classifierInput('no tags')).toEqual({ boundary: '', texts: [] });
    });

    it('answers for each text with what is decided about it', () => {
      const answer = classifierAnswer(
        (text): Found => (text === 'first' ? { competitor: ['x'] } : {}),
        content,
      );

      expect(answer).toEqual({
        results: [
          { id: 0, categories: ['competitor'], quotes: { competitor: ['x'] } },
          { id: 1, categories: [], quotes: {} },
        ],
      });
    });

    it('answers as text from the last user message, for a real model over a stub client', () => {
      const respond = classifierResponder(() => ({ competitor: [] }));

      expect(JSON.parse(respond(params([{ role: 'user', content }])) as string)).toEqual({
        results: [
          { id: 0, categories: ['competitor'], quotes: { competitor: [] } },
          { id: 1, categories: ['competitor'], quotes: { competitor: [] } },
        ],
      });
    });

    it('records calls and can tamper with, delay or fail an answer', async () => {
      const { llm, calls, peak } = createClassifierLLM(() => ({}), { answer: () => 'tampered' });
      const call = { userContent: content } as never;

      await expect(llm.call(call)).resolves.toBe('tampered');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ boundary: 't_0a1b2c', texts: ['first', 'two\nlines'] });
      expect(peak()).toBe(1);

      const slow = createClassifierLLM(() => ({}), { delayMs: 5 });
      await expect(slow.llm.call(call)).resolves.toBeTruthy();

      const controller = new AbortController();
      const aborted = slow.llm.call({ userContent: content, signal: controller.signal } as never);
      controller.abort(new Error('stop'));
      await expect(aborted).rejects.toThrow('stop');

      const bare = createClassifierLLM();
      await expect(bare.llm.call(call)).resolves.toEqual({
        results: [
          { id: 0, categories: [], quotes: {} },
          { id: 1, categories: [], quotes: {} },
        ],
      });

      const failing = createClassifierLLM(() => ({}), { error: new Error('down') });
      await expect(failing.llm.call(call)).rejects.toThrow('down');
    });
  });
});
