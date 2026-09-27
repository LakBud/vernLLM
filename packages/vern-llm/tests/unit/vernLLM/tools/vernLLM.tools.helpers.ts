export const weatherTool = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

// Pins T to `string`; without this, `expectTypeOf` assertions against
// `unknown | CallWithToolsResult<unknown>` pass no matter what, since
// `unknown | X` always collapses to `unknown`.
export const stringSchema = {
  safeParse: (d: unknown) => ({ success: true as const, data: String(d) }),
};
