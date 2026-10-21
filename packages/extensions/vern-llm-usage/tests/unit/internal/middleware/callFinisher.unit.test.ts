import { describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { createCallFinisher } from '../../../../src/internal/middleware/callFinisher.utils.js';
import { CallRecorder } from '../../../../src/internal/recorder/callRecorder.js';

import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

function setup() {
  const registry = { add: vi.fn() };
  const state = { set: vi.fn() };
  const finisher = createCallFinisher({
    guard: createGuard('silent'),
    gate: {} as never,
    warnings: {} as never,
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
    reservation: undefined,
  };
  return { finisher, call, registry, state };
}

describe('createCallFinisher', () => {
  it('counts a call once, however often it is finished', () => {
    const { finisher, call, registry, state } = setup();

    finisher.finish(call, undefined, false);
    finisher.finish(call, undefined, false);

    expect(registry.add).toHaveBeenCalledTimes(1);
    expect(state.set).toHaveBeenCalledTimes(1);
  });
});
