import { describe, expect, it } from 'vitest';

import {
  captureLogger,
  createStreamClient,
  lastUserText,
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
});
