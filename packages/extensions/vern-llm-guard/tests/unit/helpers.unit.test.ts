import { describe, expect, it } from 'vitest';

import {
  captureLogger,
  createModerationClient,
  createStreamClient,
  lastUserText,
  moderationResult,
  textDeltas,
  type CreateParams,
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
});
