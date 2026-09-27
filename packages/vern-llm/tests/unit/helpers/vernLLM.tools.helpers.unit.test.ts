import { describe, expect, it } from 'vitest';

import { stringSchema, weatherTool } from '../vernLLM/tools/vernLLM.tools.helpers.js';

/**
 * Exercises `vernLLM.tools.helpers.ts` itself. `weatherTool` is imported by
 * the tools tests, but `stringSchema.safeParse` is only ever passed as a
 * schema reference there and never invoked directly through the helper.
 * Covered directly here instead.
 */
describe('weatherTool', () => {
  it('describes the get_weather tool', () => {
    expect(weatherTool).toEqual({
      name: 'get_weather',
      description: 'Gets the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    });
  });
});

describe('stringSchema', () => {
  it('always succeeds, coercing the input with String()', () => {
    expect(stringSchema.safeParse('hi')).toEqual({ success: true, data: 'hi' });
    expect(stringSchema.safeParse(42)).toEqual({ success: true, data: '42' });
    expect(stringSchema.safeParse(undefined)).toEqual({ success: true, data: 'undefined' });
  });
});
