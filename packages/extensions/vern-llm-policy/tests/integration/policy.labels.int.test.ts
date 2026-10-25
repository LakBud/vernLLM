import { createStateKey, stateEntry } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { captureLogger, harness } from '../helpers.js';

import type { PolicyOptions } from '../../src/index.js';

const call = { userContent: 'hi', jsonMode: false as const };

/** Stands in for what an outer middleware, such as a content guard, would store for the call. */
const labelsKey = createStateKey<readonly string[]>('test.labels');
const withLabels = (labels?: readonly string[]) => ({
  ...call,
  ...(labels && { state: [stateEntry(labelsKey, labels)] }),
});

const targets = {
  primary: { zdr: false },
  b: { zdr: true },
  c: { zdr: true },
};

const piiNeedsZdr = { id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } };
const labels: NonNullable<PolicyOptions['labels']> = (ctx) => ctx.state.get(labelsKey);

describe('labels in a real call', () => {
  it('send a call with pii only to the targets that keep nothing', async () => {
    const { llm, probe, events } = harness({ targets, labels, rules: [piiNeedsZdr] });

    await llm.call(withLabels(['pii']));

    expect(probe.seen).toEqual([['b', 'c']]);
    expect(events[0]!.data).toMatchObject({ removed: { primary: 'pii-zdr' }, labels: ['pii'] });
  });

  it('leave a call with other labels alone', async () => {
    const { llm, probe, events } = harness({ targets, labels, rules: [piiNeedsZdr] });

    await llm.call(withLabels(['health']));

    expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    expect(events[0]!.data).toMatchObject({ labels: ['health'] });
  });

  it('leave a call that was checked and found nothing alone, without a warning', async () => {
    const log = captureLogger();
    const { llm, probe, events } = harness({
      targets,
      labels,
      logger: log.logger,
      rules: [piiNeedsZdr],
    });

    await llm.call(withLabels([]));

    expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    expect(events[0]!.data).toMatchObject({ labels: [], errors: [] });
    expect(log.warnings()).toEqual([]);
  });

  describe('when the labeler never ran for the call', () => {
    it('fail closed: the forbid applies, and the event says the labels are unknown', async () => {
      const { llm, probe, events } = harness({ targets, labels, rules: [piiNeedsZdr] });

      await llm.call(withLabels());

      expect(probe.seen).toEqual([['b', 'c']]);
      expect(events[0]!.data).toMatchObject({
        labels: 'unknown',
        errors: [{ rule: 'pii-zdr', name: 'LabelsUnknownError' }],
      });
    });

    it('say so once, since it is a setup mistake that repeats on every call', async () => {
      const log = captureLogger();
      const { llm } = harness({ targets, labels, logger: log.logger, rules: [piiNeedsZdr] });

      await llm.call(withLabels());
      await llm.call(withLabels());

      expect(log.warnings()).toEqual([
        '[VernLLM] policy: the labels function returned undefined, so labels are unknown and rules using them fail closed',
        '[VernLLM] policy: rule "pii-zdr" threw while deciding a call, so it fails closed: the labels are unknown',
      ]);
    });

    it('skip the rule under onError open', async () => {
      const { llm, probe } = harness({
        targets,
        labels,
        onError: 'open',
        rules: [piiNeedsZdr],
      });

      await llm.call(withLabels());

      expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    });
  });

  describe('when the labeler throws', () => {
    const throwing = () => {
      throw new Error('guard crashed');
    };

    it('treats the labels as unknown and lists the failure', async () => {
      const log = captureLogger();
      const { llm, probe, events } = harness({
        targets,
        labels: throwing,
        logger: log.logger,
        rules: [piiNeedsZdr],
      });

      expect(await llm.call(call)).toBe('b');

      expect(probe.seen).toEqual([['b', 'c']]);
      expect(events[0]!.data).toMatchObject({
        labels: 'unknown',
        errors: [{ name: 'Error' }, { rule: 'pii-zdr', name: 'LabelsUnknownError' }],
      });
      expect(log.warnings()[0]).toBe(
        '[VernLLM] policy: the labels function failed: guard crashed, so labels are unknown and rules using them fail closed',
      );
    });

    it('treats an answer that is not a list of strings the same way', async () => {
      const { llm, events } = harness({
        targets,
        labels: (() => 'pii') as never,
        rules: [piiNeedsZdr],
      });

      await llm.call(call);

      expect(events[0]!.data).toMatchObject({
        labels: 'unknown',
        errors: [{ name: 'TypeError' }, { rule: 'pii-zdr' }],
      });
    });
  });

  describe('the labeler', () => {
    it('runs once per call, and is handed the call context', async () => {
      const spy = vi.fn(labels);
      const { llm } = harness({
        targets,
        labels: spy,
        rules: [piiNeedsZdr, { ...piiNeedsZdr, id: 'second' }],
      });

      await llm.call(withLabels(['pii']));
      await llm.call(withLabels(['pii']));

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0]![0]).toMatchObject({ stage: 'pre-dispatch' });
    });

    it('does not run when no rule reads labels', async () => {
      const spy = vi.fn(() => ['pii']);
      const { llm, events } = harness({
        targets,
        labels: spy,
        rules: [{ id: 'a', forbid: { name: 'b' } }],
      });

      await llm.call(call);

      expect(spy).not.toHaveBeenCalled();
      expect(Object.hasOwn(events[0]!.data as object, 'labels')).toBe(false);
    });
  });
});

describe('a labeler that only a function can read', () => {
  const rules = [{ id: 'fn', forbid: { name: 'b' }, when: () => true }];

  it('says nothing when it did not run, since no rule depends on the labels', async () => {
    const log = captureLogger();
    const { llm, events } = harness({ logger: log.logger, labels, rules });

    await llm.call(withLabels());

    expect(log.warnings()).toEqual([]);
    expect(events[0]!.data).toMatchObject({ labels: 'unknown', errors: [] });
  });

  it('still hands the labels to the function when there are some', async () => {
    const seen: unknown[] = [];
    const { llm } = harness({
      labels,
      rules: [
        {
          id: 'fn',
          forbid: { name: 'b' },
          when: (facts) => {
            seen.push(facts.labels);
            return true;
          },
        },
      ],
    });

    await llm.call(withLabels(['pii']));

    expect(seen).toEqual([['pii']]);
  });
});
