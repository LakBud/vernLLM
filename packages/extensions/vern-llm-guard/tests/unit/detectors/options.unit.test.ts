import { describe, expect, it } from 'vitest';

import { openaiModeration, type OpenAIModerationOptions } from '../../../src/index.js';
import { createModerationClient } from '../../helpers.js';

const { client } = createModerationClient();

/** The options of a detector that would otherwise be fine, with one of them changed. */
const build = (options: Record<string, unknown> = {}) =>
  openaiModeration({ client, model: 'pinned', ...options } as OpenAIModerationOptions);

describe('detector options', () => {
  describe('every hosted detector', () => {
    it.each([
      ['concurrency', 0, 'openaiModeration: concurrency must be an integer of at least 1'],
      ['concurrency', 1.5, 'openaiModeration: concurrency must be an integer of at least 1'],
      ['concurrency', '4', 'openaiModeration: concurrency must be an integer of at least 1'],
      ['chunkChars', 999, 'openaiModeration: chunkChars must be an integer of at least 1000'],
      ['chunkChars', 1000.5, 'openaiModeration: chunkChars must be an integer of at least 1000'],
      [
        'overlapChars',
        -1,
        'openaiModeration: overlapChars must be an integer of at least 0 and below chunkChars',
      ],
      [
        'overlapChars',
        8000,
        'openaiModeration: overlapChars must be an integer of at least 0 and below chunkChars',
      ],
      [
        'overlapChars',
        0.5,
        'openaiModeration: overlapChars must be an integer of at least 0 and below chunkChars',
      ],
      ['cache', true, 'openaiModeration: cache must be false or an object with max'],
      ['cache', null, 'openaiModeration: cache must be false or an object with max'],
      ['cache', { max: 0 }, 'openaiModeration: cache.max must be an integer of at least 1'],
      ['cache', { max: 1.5 }, 'openaiModeration: cache.max must be an integer of at least 1'],
      ['onUsage', 'log', 'openaiModeration: onUsage must be a function'],
    ])('rejects %s of %j', (field, value, message) => {
      expect(() => build({ [field]: value })).toThrow(new TypeError(message));
    });

    it('checks overlapChars against the chunkChars it was given', () => {
      expect(() => build({ chunkChars: 1000, overlapChars: 1000 })).toThrow(/below chunkChars/);
      expect(() => build({ chunkChars: 1000, overlapChars: 999 })).not.toThrow();
    });

    it('accepts the values at the edge, and cache off or sized', () => {
      expect(() =>
        build({ concurrency: 1, chunkChars: 1000, overlapChars: 0, cache: { max: 1 } }),
      ).not.toThrow();
      expect(() => build({ cache: false })).not.toThrow();
      expect(() => build({ cache: {} })).not.toThrow();
    });
  });

  describe('openaiModeration', () => {
    it.each([
      ['no client', undefined],
      ['no moderations', {}],
      ['no create', { moderations: {} }],
      ['a create that is not a function', { moderations: { create: 'yes' } }],
    ])('rejects a client with %s', (_name, bad) => {
      expect(() => openaiModeration({ client: bad } as never)).toThrow(
        new TypeError('openaiModeration: client.moderations.create must be a function'),
      );
    });

    it.each([[''], [7], [null]])('rejects a model of %j', (model) => {
      expect(() => build({ model })).toThrow(
        new TypeError('openaiModeration: model must be a non empty string'),
      );
    });

    it.each([[0], [257], [1.5], ['32']])('rejects a batchSize of %j', (batchSize) => {
      expect(() => build({ batchSize })).toThrow(
        new TypeError('openaiModeration: batchSize must be an integer from 1 to 256'),
      );
    });

    it('accepts the edges of batchSize', () => {
      expect(() => build({ batchSize: 1 })).not.toThrow();
      expect(() => build({ batchSize: 256 })).not.toThrow();
    });

    it('rejects a threshold for a category that does not exist', () => {
      expect(() => build({ thresholds: { violnce: 0.5 } })).toThrow(
        new TypeError('openaiModeration: thresholds has an unknown category "violnce"'),
      );
    });

    it.each([[-0.1], [1.1], [Number.NaN], ['0.5'], [null]])(
      'rejects a threshold of %j',
      (limit) => {
        expect(() => build({ thresholds: { hate: limit } })).toThrow(
          new TypeError('openaiModeration: the threshold for "hate" must be a number from 0 to 1'),
        );
      },
    );

    it('accepts thresholds from 0 to 1, in any known category', () => {
      expect(() =>
        build({ thresholds: { hate: 0, 'self-harm/intent': 1, 'violence/graphic': 0.5 } }),
      ).not.toThrow();
      expect(() => build({ thresholds: {} })).not.toThrow();
    });
  });
});
