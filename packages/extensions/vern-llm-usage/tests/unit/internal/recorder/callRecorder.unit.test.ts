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
      tokens: { input: 30, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 2 },
      tableCharges: 2,
      reportedCharges: 0,
      unpricedCharges: 1,
      provider: 'backup',
      model: 'b',
    });
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
