import { describe, expect, it } from 'vitest';

import { normalizeCustomEvents } from '../../../../src/internal/options/customEventsOptions.utils.js';

describe('normalizeCustomEvents', () => {
  it('keeps the first party namespaces with no configuration', () => {
    const keep = normalizeCustomEvents(undefined);

    expect(keep('usage.budget_warning')).toBe(true);
    expect(keep('policy.decision')).toBe(true);
    expect(keep('router.decision')).toBe(true);
    expect(keep('myapp.thing')).toBe(false);
  });

  it('adds a list to the defaults', () => {
    const keep = normalizeCustomEvents(['myapp.*', 'exact.name']);

    expect(keep('myapp.anything')).toBe(true);
    expect(keep('exact.name')).toBe(true);
    expect(keep('exact.name.more')).toBe(false);
    expect(keep('usage.budget_exceeded')).toBe(true);
  });

  it('drops the defaults when asked to', () => {
    const keep = normalizeCustomEvents({ defaults: false, names: ['myapp.*'] });

    expect(keep('myapp.x')).toBe(true);
    expect(keep('usage.budget_warning')).toBe(false);
  });

  it('a prefix pattern does not match a longer first segment', () => {
    const keep = normalizeCustomEvents(['app.*']);

    expect(keep('app.x')).toBe(true);
    expect(keep('apple.x')).toBe(false);
    expect(keep('app')).toBe(false);
  });

  it('keeps nothing with no defaults and no names', () => {
    const keep = normalizeCustomEvents({ defaults: false });
    expect(keep('usage.budget_warning')).toBe(false);
  });

  it.each([['*'], ['a.*.b'], ['a b'], ['a.**'], ['']])('rejects the pattern %j', (pattern) => {
    expect(() => normalizeCustomEvents([pattern])).toThrow(/loggerMiddleware: customEvents/);
  });

  it.each([[42], ['usage.*'], [null]])('rejects %j as the option', (value) => {
    expect(() => normalizeCustomEvents(value as never)).toThrow(
      /customEvents must be an array or an object/,
    );
  });

  it('rejects a non boolean defaults and a non array names', () => {
    expect(() => normalizeCustomEvents({ defaults: 'yes' } as never)).toThrow(
      /customEvents.defaults must be a boolean/,
    );
    expect(() => normalizeCustomEvents({ names: 'a.b' } as never)).toThrow(
      /customEvents.names must be an array/,
    );
  });
});
