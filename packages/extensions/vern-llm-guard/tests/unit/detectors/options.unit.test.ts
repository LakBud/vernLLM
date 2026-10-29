import { describe, expect, it } from 'vitest';

import {
  llmClassifier,
  openaiModeration,
  type LLMClassifierOptions,
  type OpenAIModerationOptions,
} from '../../../src/index.js';
import { createClassifierLLM, createModerationClient } from '../../helpers.js';

const { client } = createModerationClient();
const { llm } = createClassifierLLM();

/** The options of a detector that would otherwise be fine, with one of them changed. */
const build = (options: Record<string, unknown> = {}) =>
  openaiModeration({ client, model: 'pinned', ...options } as OpenAIModerationOptions);

const buildClassifier = (options: Record<string, unknown> = {}) =>
  llmClassifier({
    llm,
    categories: { competitor: 'Names a competitor' },
    ...options,
  } as LLMClassifierOptions);

const hosted = [
  ['openaiModeration', build],
  ['llmClassifier', buildClassifier],
] as const;

describe('detector options', () => {
  describe.each(hosted)('%s, as every hosted detector', (name, make) => {
    const integer = `${name}: concurrency must be an integer of at least 1`;
    const chunk = `${name}: chunkChars must be an integer of at least 1000`;
    const overlap = `${name}: overlapChars must be an integer of at least 0 and below chunkChars`;

    it.each([
      ['concurrency', 0, integer],
      ['concurrency', 1.5, integer],
      ['concurrency', '4', integer],
      ['chunkChars', 999, chunk],
      ['chunkChars', 1000.5, chunk],
      ['overlapChars', -1, overlap],
      ['overlapChars', 16_000, overlap],
      ['overlapChars', 0.5, overlap],
      ['cache', true, `${name}: cache must be false or an object with max`],
      ['cache', null, `${name}: cache must be false or an object with max`],
      ['cache', { max: 0 }, `${name}: cache.max must be an integer of at least 1`],
      ['cache', { max: 1.5 }, `${name}: cache.max must be an integer of at least 1`],
      ['onUsage', 'log', `${name}: onUsage must be a function`],
    ])('rejects %s of %j', (field, value, message) => {
      expect(() => make({ [field]: value })).toThrow(new TypeError(message));
    });

    it('checks overlapChars against the chunkChars it was given', () => {
      expect(() => make({ chunkChars: 1000, overlapChars: 1000 })).toThrow(/below chunkChars/);
      expect(() => make({ chunkChars: 1000, overlapChars: 999 })).not.toThrow();
    });

    it('accepts the values at the edge, and cache off or sized', () => {
      expect(() =>
        make({ concurrency: 1, chunkChars: 1000, overlapChars: 0, cache: { max: 1 } }),
      ).not.toThrow();
      expect(() => make({ cache: false })).not.toThrow();
      expect(() => make({ cache: {} })).not.toThrow();
    });

    it('needs at least one kind for a view, and only known ones', () => {
      const detector = make({});

      expect(() => detector.only()).toThrow(
        new TypeError(`${name}: only() needs at least one kind`),
      );
      expect(() => detector.only('weapons' as never)).toThrow(
        new TypeError(`${name}: unknown kind "weapons"`),
      );
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

  describe('llmClassifier', () => {
    it.each([
      ['no llm', undefined],
      ['no call', {}],
      ['a call that is not a function', { call: 'yes' }],
    ])('rejects an llm with %s', (_name, bad) => {
      expect(() => buildClassifier({ llm: bad })).toThrow(
        new TypeError('llmClassifier: llm.call must be a function'),
      );
    });

    it.each([
      ['no categories', undefined],
      ['none', {}],
      ['a list', ['competitor']],
      ['text', 'competitor'],
    ])('rejects categories of %s', (_name, categories) => {
      expect(() => buildClassifier({ categories })).toThrow(
        new TypeError('llmClassifier: categories must be an object with at least one category'),
      );
    });

    it.each([[''], ['Competitor'], ['off-topic'], ['off topic'], ['a'.repeat(41)]])(
      'rejects a category named %j',
      (name) => {
        expect(() => buildClassifier({ categories: { [name]: 'something' } })).toThrow(
          new TypeError(
            `llmClassifier: the category name "${name}" must match [a-z0-9_] and be 1 to 40 characters`,
          ),
        );
      },
    );

    it('accepts names of 1 to 40 characters from a to z, 0 to 9 and _', () => {
      expect(() => buildClassifier({ categories: { a: 'x' } })).not.toThrow();
      expect(() =>
        buildClassifier({ categories: { [`a_9${'z'.repeat(37)}`]: 'x' } }),
      ).not.toThrow();
    });

    it.each([[''], ['  '], [7], [null]])('rejects a description of %j', (description) => {
      expect(() => buildClassifier({ categories: { competitor: description } })).toThrow(
        new TypeError(
          'llmClassifier: the description of category "competitor" must be a non empty string',
        ),
      );
    });

    it.each([[7], [null], [{}]])('rejects instructions of %j', (instructions) => {
      expect(() => buildClassifier({ instructions })).toThrow(
        new TypeError('llmClassifier: instructions must be a string'),
      );
    });

    it('accepts instructions, and empty ones', () => {
      expect(() => buildClassifier({ instructions: 'Be strict.' })).not.toThrow();
      expect(() => buildClassifier({ instructions: '' })).not.toThrow();
    });

    it.each([['yes'], [1], [null]])('rejects quotes of %j', (quotes) => {
      expect(() => buildClassifier({ quotes })).toThrow(
        new TypeError('llmClassifier: quotes must be a boolean'),
      );
    });

    it.each([[0], [17], [1.5], ['1']])('rejects a batchSize of %j', (batchSize) => {
      expect(() => buildClassifier({ batchSize })).toThrow(
        new TypeError('llmClassifier: batchSize must be an integer from 1 to 16'),
      );
    });

    it('accepts the edges of batchSize', () => {
      expect(() => buildClassifier({ batchSize: 1 })).not.toThrow();
      expect(() => buildClassifier({ batchSize: 16 })).not.toThrow();
    });

    it.each([[0], [-1], [1.5], ['300'], [null]])('rejects a maxTokens of %j', (maxTokens) => {
      expect(() => buildClassifier({ maxTokens })).toThrow(
        new TypeError('llmClassifier: maxTokens must be a positive integer'),
      );
    });

    it('accepts a maxTokens of 1', () => {
      expect(() => buildClassifier({ maxTokens: 1 })).not.toThrow();
    });
  });
});
