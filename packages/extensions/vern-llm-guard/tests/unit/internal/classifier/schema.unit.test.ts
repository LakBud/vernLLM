import { describe, expect, it } from 'vitest';

import { answerSchema, createValidator } from '../../../../src/internal/classifier/schema.js';

const names = ['competitor', 'off_topic'];

describe('answerSchema', () => {
  it('makes the categories an enum, and requires every property, as a strict schema needs', () => {
    expect(answerSchema(names, false)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'categories'],
            properties: {
              id: { type: 'integer' },
              categories: { type: 'array', items: { type: 'string', enum: names } },
            },
          },
        },
      },
    });
  });

  it('adds quotes by category, all required, with quotes', () => {
    const schema = answerSchema(names, true) as {
      properties: { results: { items: Record<string, unknown> } };
    };

    const entry = schema.properties.results.items as {
      required: string[];
      properties: { quotes: Record<string, unknown> };
    };
    expect(entry.required).toEqual(['id', 'categories', 'quotes']);
    expect(entry.properties.quotes).toEqual({
      type: 'object',
      additionalProperties: false,
      required: names,
      properties: {
        competitor: { type: 'array', items: { type: 'string' } },
        off_topic: { type: 'array', items: { type: 'string' } },
      },
    });
  });
});

describe('createValidator', () => {
  const plain = createValidator(names, false);
  const quoted = createValidator(names, true);

  it('accepts an answer that fits, and returns it as it is', () => {
    const answer = {
      results: [
        { id: 0, categories: ['competitor'] },
        { id: 1, categories: [] },
      ],
    };

    expect(plain.safeParse(answer)).toEqual({ success: true, data: answer });
  });

  it('accepts quotes by category, with or without every category in them', () => {
    const answer = {
      results: [{ id: 0, categories: ['competitor'], quotes: { competitor: ['Acme'] } }],
    };

    expect(quoted.safeParse(answer)).toEqual({ success: true, data: answer });
    expect(quoted.safeParse({ results: [{ id: 0, categories: [], quotes: {} }] }).success).toBe(
      true,
    );
  });

  it('does not look at quotes it did not ask for', () => {
    expect(
      plain.safeParse({ results: [{ id: 0, categories: [], quotes: 'anything' }] }).success,
    ).toBe(true);
  });

  it.each([
    ['nothing', undefined, 'results must be an array'],
    ['a list', [], 'results must be an array'],
    ['results that are not a list', { results: {} }, 'results must be an array'],
    ['a result that is not an object', { results: [null] }, 'results[0] must be an object'],
    [
      'an id that is not an integer',
      { results: [{ id: 1.5, categories: [] }] },
      'results[0].id must be an integer',
    ],
    [
      'an id that is text',
      { results: [{ id: '0', categories: [] }] },
      'results[0].id must be an integer',
    ],
    [
      'a category it was not given',
      { results: [{ id: 0, categories: ['weapons'] }] },
      'results[0].categories must list only the categories given',
    ],
    [
      'categories that are not text',
      { results: [{ id: 0, categories: [1] }] },
      'results[0].categories must list only the categories given',
    ],
  ])('rejects %s, and says where without quoting it', (_name, data, problem) => {
    const checked = plain.safeParse(data);

    expect(checked.success).toBe(false);
    expect((checked as { error: Error }).error.message).toBe(problem);
  });

  it.each([
    ['no quotes', { results: [{ id: 0, categories: [] }] }, 'results[0].quotes must be an object'],
    [
      'quotes that are a list',
      { results: [{ id: 0, categories: [], quotes: [] }] },
      'results[0].quotes must be an object',
    ],
    [
      'a quote for a category it was not given',
      { results: [{ id: 0, categories: [], quotes: { weapons: [] } }] },
      'results[0].quotes must be lists of text, by category given',
    ],
    [
      'quotes that are not lists of text',
      { results: [{ id: 0, categories: [], quotes: { competitor: [1] } }] },
      'results[0].quotes must be lists of text, by category given',
    ],
  ])('rejects %s when it asked for quotes', (_name, data, problem) => {
    const checked = quoted.safeParse(data);

    expect(checked.success).toBe(false);
    expect((checked as { error: Error }).error.message).toBe(problem);
  });
});
