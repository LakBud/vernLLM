import { LLMError, createMiddlewareStateBag } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import {
  classifierCallKey,
  classifierCallState,
  refuseClassifierCall,
} from '../../../../src/internal/middleware/classifierCall.js';
import { captureLogger } from '../../../helpers.js';

function setup(entries: Parameters<typeof createMiddlewareStateBag>[0] = []) {
  const log = captureLogger();
  return {
    log,
    guard: createGuard(log.logger),
    state: createMiddlewareStateBag(entries),
  };
}

describe('refuseClassifierCall', () => {
  it('refuses a call the classifier marked, with an error that names the fix', () => {
    const { guard, state } = setup(classifierCallState);

    let thrown: unknown;
    try {
      refuseClassifierCall(state, guard);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LLMError);
    expect(thrown).toMatchObject({ type: 'invalid_params' });
    expect((thrown as LLMError).message).toContain('Give llmClassifier its own VernLLM');
  });

  it('warns once, however many calls it refuses', () => {
    const { guard, state, log } = setup(classifierCallState);

    for (let call = 0; call < 3; call += 1) {
      expect(() => refuseClassifierCall(state, guard)).toThrow(LLMError);
    }

    expect(log.warnings()).toHaveLength(1);
    expect(log.warnings()[0]).toContain('Give llmClassifier its own VernLLM');
  });

  it.each([
    ['a call with no mark', []],
    ['a call whose mark is false', [[classifierCallKey, false] as const]],
  ])('leaves %s alone', (_name, entries) => {
    const { guard, state, log } = setup(entries);

    expect(() => refuseClassifierCall(state, guard)).not.toThrow();
    expect(log.warnings()).toEqual([]);
  });
});
