import { describe, expect, it } from 'vitest';

import { CallRecorder } from '../../../../src/internal/recorder/callRecorder.js';

describe('CallRecorder', () => {
  it('sums charges, wasted ones included, and reports the wasted part separately', () => {
    const recorder = new CallRecorder();

    recorder.charge(3_000_000, true, 30);
    recorder.charge(6_000_000, false, 60);

    expect(recorder.commit()).toEqual({
      estimatedCostUsd: 0.009,
      wastedUsd: 0.003,
      costSource: 'table',
    });
  });

  it('marks the whole call unpriced when any charge was, since its cost is then a lower bound', () => {
    const recorder = new CallRecorder();

    recorder.charge(1_000_000, false, 10);
    recorder.charge(undefined, true, 5);

    expect(recorder.commit()).toEqual({
      estimatedCostUsd: 0.001,
      wastedUsd: 0,
      costSource: 'unpriced',
    });
  });

  it('names no source for a call with no charges', () => {
    expect(new CallRecorder().commit()).toEqual({ estimatedCostUsd: 0, wastedUsd: 0 });
  });

  it('settles once, and drops anything charged after', () => {
    const recorder = new CallRecorder();
    recorder.charge(1_000_000, false, 10);

    expect(recorder.commit()).toBeDefined();
    recorder.charge(9_000_000, false, 90);

    expect(recorder.commit()).toBeUndefined();
  });

  it('reports what was really spent for a store to settle, unpriced tokens included', () => {
    const recorder = new CallRecorder();

    recorder.charge(3_000_000, true, 30);
    recorder.charge(undefined, false, 5);

    expect(recorder.amount()).toEqual({ nanoUsd: 3_000_000, tokens: 35 });
  });

  it('reports zero for a call that was never charged', () => {
    expect(new CallRecorder().amount()).toEqual({ nanoUsd: 0, tokens: 0 });
  });

  it('snapshots the money, token kinds, charge sources and the last answering model', () => {
    const recorder = new CallRecorder();
    const kinds = (input: number) => ({
      input,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      reasoning: 1,
    });

    recorder.charge(3_000_000, true, 12, { provider: 'primary', model: 'a', kinds: kinds(10) });
    recorder.charge(undefined, false, 22, { provider: 'backup', model: 'b', kinds: kinds(20) });
    recorder.charge(1_000_000, false, 5);

    expect(recorder.snapshot()).toEqual({
      nanoUsd: 4_000_000,
      wastedNanoUsd: 3_000_000,
      unkeptNanoUsd: 0,
      tokens: { input: 30, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 2 },
      tableCharges: 2,
      reportedCharges: 0,
      unpricedCharges: 1,
      provider: 'backup',
      model: 'b',
      parts: [
        {
          provider: 'primary',
          model: 'a',
          nanoUsd: 3_000_000,
          wastedNanoUsd: 3_000_000,
          unkeptNanoUsd: 0,
          tokens: kinds(10),
          tableCharges: 1,
          reportedCharges: 0,
          unpricedCharges: 0,
        },
        {
          provider: 'backup',
          model: 'b',
          nanoUsd: 0,
          wastedNanoUsd: 0,
          unkeptNanoUsd: 0,
          tokens: kinds(20),
          tableCharges: 0,
          reportedCharges: 0,
          unpricedCharges: 1,
        },
        {
          nanoUsd: 1_000_000,
          wastedNanoUsd: 0,
          unkeptNanoUsd: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          tableCharges: 1,
          reportedCharges: 0,
          unpricedCharges: 0,
        },
      ],
    });
  });

  it('merges the charges of one provider and model into one part', () => {
    const recorder = new CallRecorder();
    const kinds = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

    recorder.charge(1_000_000, true, 5, { provider: 'p', model: 'm', kinds });
    recorder.charge(2_000_000, false, 5, { provider: 'p', model: 'm', kinds });

    expect(recorder.snapshot().parts).toEqual([
      expect.objectContaining({
        provider: 'p',
        model: 'm',
        nanoUsd: 3_000_000,
        wastedNanoUsd: 1_000_000,
        tableCharges: 2,
        tokens: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      }),
    ]);
  });

  it('knows when it is done', () => {
    const recorder = new CallRecorder();

    expect(recorder.done).toBe(false);
    recorder.commit();
    expect(recorder.done).toBe(true);
  });

  it('has no provider or model for a call that was never charged', () => {
    expect(new CallRecorder().snapshot()).toMatchObject({ provider: undefined, model: undefined });
  });

  it('takes the weakest source among the charges: unpriced, then table, then reported', () => {
    const kinds = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const reported = { model: 'm', kinds, reported: true };
    const sourceOf = (charges: (() => void)[]) => {
      const recorder = new CallRecorder();
      return { recorder, run: () => (charges.forEach((c) => c()), recorder.commit()?.costSource) };
    };

    const onlyReported = new CallRecorder();
    onlyReported.charge(5, false, 2, reported);
    expect(onlyReported.commit()?.costSource).toBe('reported');
    expect(onlyReported.snapshot()).toMatchObject({ reportedCharges: 1, tableCharges: 0 });

    const withTable = new CallRecorder();
    withTable.charge(5, false, 2, reported);
    withTable.charge(5, true, 2);
    expect(withTable.commit()?.costSource).toBe('table');

    const withUnpriced = new CallRecorder();
    withUnpriced.charge(5, false, 2, reported);
    withUnpriced.charge(undefined, false, 2);
    expect(withUnpriced.commit()?.costSource).toBe('unpriced');
    void sourceOf;
  });
});
