import { describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { createCallFinisher } from '../../../../src/internal/middleware/callFinisher.utils.js';
import { CallRecorder } from '../../../../src/internal/recorder/callRecorder.js';

import type { Reservation } from '../../../../src/internal/budgets/gate.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

function setup() {
  const registry = { add: vi.fn() };
  const state = { set: vi.fn() };
  const gate = { settle: vi.fn(), release: vi.fn() };
  const warnings = { check: vi.fn() };
  const finisher = createCallFinisher({
    guard: createGuard('silent'),
    gate: gate as never,
    warnings: warnings as never,
    registry: registry as never,
    savedSpend: vi.fn(),
    attribute: [],
  });
  const call = {
    recorder: new CallRecorder(),
    request: {} as WireCallRequest,
    ctx: {
      state,
      context: undefined,
      primaryProvider: 'primary',
      primaryModel: 'm',
    } as unknown as PreDispatchContext,
    reservation: undefined as Reservation | undefined,
  };
  return { finisher, call, registry, state, gate, warnings };
}

const held = { nanoUsd: 700, tokens: 50 };
const reservation: Reservation = { id: 'res_1', scopes: [], held, shares: [] };

describe('createCallFinisher', () => {
  it('counts a call once, however often it is finished', () => {
    const { finisher, call, registry, state } = setup();

    finisher.finish(call, undefined, false);
    finisher.finish(call, undefined, false);

    expect(registry.add).toHaveBeenCalledTimes(1);
    expect(state.set).toHaveBeenCalledTimes(1);
  });

  it('settles a reservation once, however often the call is finished', () => {
    const { finisher, call, gate } = setup();
    call.reservation = reservation;
    call.recorder.charge(300, false, 20);

    finisher.finish(call, undefined, false);
    finisher.finish(call, undefined, false);

    expect(gate.settle).toHaveBeenCalledTimes(1);
    expect(gate.settle).toHaveBeenCalledWith(reservation, { nanoUsd: 300, tokens: 20 });
    expect(gate.release).not.toHaveBeenCalled();
  });

  it('frees the hold of a call that reported no usage', () => {
    const { finisher, call, gate } = setup();
    call.reservation = reservation;

    finisher.finish(call, undefined, false);

    expect(gate.release).toHaveBeenCalledTimes(1);
    expect(gate.settle).not.toHaveBeenCalled();
  });

  it('keeps the hold as the spend of an aborted stream, whose usage is never reported', () => {
    const { finisher, call, gate } = setup();
    call.reservation = reservation;

    finisher.finish(call, undefined, true);

    expect(gate.release).not.toHaveBeenCalled();
    expect(gate.settle).toHaveBeenCalledWith(reservation, held);
  });

  it('never lowers the spend of an aborted stream below what was reported', () => {
    const { finisher, call, gate } = setup();
    call.reservation = reservation;
    call.recorder.charge(900, true, 10);

    finisher.finish(call, undefined, true);

    expect(gate.settle).toHaveBeenCalledWith(reservation, { nanoUsd: 900, tokens: 50 });
  });
});
