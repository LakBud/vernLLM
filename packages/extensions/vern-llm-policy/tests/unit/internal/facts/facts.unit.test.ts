import { describe, expect, it } from 'vitest';

import { readOnly } from '../../../../src/internal/facts/readOnly.utils.js';
import { targetFacts } from '../../../../src/internal/facts/targetFacts.utils.js';
import { compile } from '../../../../src/internal/options/compile.utils.js';

import type { TargetInfo } from 'vern-llm';

const info = (name: string, model = `${name}-model`, provider?: string): TargetInfo => ({
  name,
  index: 0,
  model,
  adapter: provider === undefined ? { name: 'custom' } : { name: 'custom', provider },
});

describe('targetFacts', () => {
  const policy = compile({ targets: { eu: { region: 'eu', zdr: true } } });

  it('joins the declared attributes to name and model', () => {
    expect(targetFacts(policy, info('eu'))).toEqual({
      region: 'eu',
      zdr: true,
      name: 'eu',
      model: 'eu-model',
    });
  });

  it('leaves provider out when the adapter does not know it', () => {
    expect(Object.hasOwn(targetFacts(policy, info('eu')), 'provider')).toBe(false);
    expect(targetFacts(policy, info('eu', 'm', 'openai'))).toMatchObject({ provider: 'openai' });
  });

  it('gives a target that declares nothing just the built in facts', () => {
    expect(targetFacts(policy, info('other'))).toEqual({ name: 'other', model: 'other-model' });
  });

  it('does not read a declared name off the prototype', () => {
    expect(targetFacts(policy, info('constructor'))).toEqual({
      name: 'constructor',
      model: 'constructor-model',
    });
  });

  it('builds the facts once per name, model and provider', () => {
    const first = targetFacts(policy, info('eu'));

    expect(targetFacts(policy, info('eu'))).toBe(first);
    expect(targetFacts(policy, info('eu', 'override'))).not.toBe(first);
    expect(targetFacts(policy, info('eu', 'eu-model', 'openai'))).not.toBe(first);
  });

  it('keeps each policy to its own facts', () => {
    const other = compile({ targets: { eu: { region: 'us' } } });

    expect(targetFacts(other, info('eu'))).toMatchObject({ region: 'us' });
    expect(targetFacts(policy, info('eu'))).toMatchObject({ region: 'eu' });
  });

  it('stays correct when the cache fills and starts over', () => {
    for (let i = 0; i < 600; i++) targetFacts(policy, info('eu', `model-${i}`));

    expect(targetFacts(policy, info('eu', 'model-0'))).toEqual({
      region: 'eu',
      zdr: true,
      name: 'eu',
      model: 'model-0',
    });
  });

  it('cannot be changed by a rule', () => {
    expect(Object.isFrozen(targetFacts(policy, info('eu')))).toBe(true);
  });
});

describe('readOnly', () => {
  const refusal = 'a policy function must not change the facts of a call';

  it('reads like the object it wraps, down to nested objects and lists', () => {
    const view = readOnly({ plan: 'free', tags: ['a', 'b'], team: { id: 7 } });

    expect(view.plan).toBe('free');
    expect(view.tags.map((tag) => tag.toUpperCase())).toEqual(['A', 'B']);
    expect(Array.isArray(view.tags)).toBe(true);
    expect(view.team.id).toBe(7);
    expect(Object.keys(view)).toEqual(['plan', 'tags', 'team']);
    expect(Object.hasOwn(view, 'plan')).toBe(true);
  });

  it('refuses every kind of change, at any depth', () => {
    const view = readOnly({ plan: 'free', tags: ['a'], team: { id: 7 } });

    expect(() => {
      view.plan = 'paid';
    }).toThrow(refusal);
    expect(() => {
      view.team.id = 8;
    }).toThrow(refusal);
    expect(() => view.tags.push('b')).toThrow(refusal);
    expect(() => delete (view as { plan?: string }).plan).toThrow(refusal);
    expect(() => Object.defineProperty(view, 'x', { value: 1 })).toThrow(refusal);
    expect(() => Object.setPrototypeOf(view, null)).toThrow(refusal);
  });

  it('leaves the original untouched and is the same view each time', () => {
    const original = { team: { id: 7 } };
    const view = readOnly(original);

    expect(() => {
      view.team.id = 8;
    }).toThrow();

    expect(original.team.id).toBe(7);
    expect(view.team).toBe(view.team);
    expect(readOnly(original)).toBe(view);
  });

  it('leaves values it cannot wrap as they are', () => {
    const date = new Date(0);
    const map = new Map([['a', 1]]);

    expect(readOnly(date)).toBe(date);
    expect(readOnly(map)).toBe(map);
    expect(readOnly('text')).toBe('text');
    expect(readOnly(undefined)).toBeUndefined();
    expect(readOnly(null)).toBeNull();
  });

  it('works on an object that is already frozen', () => {
    const view = readOnly(Object.freeze({ team: Object.freeze({ id: 7 }) }));

    expect(view.team.id).toBe(7);
  });
});
