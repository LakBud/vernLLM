import type { CallLogRecord } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { CallRecorder } from '../recorder/callRecorder.js';
import type { CallResult } from 'vern-llm';

type Outcome = Parameters<CallRecorder['finish']>[0];

export interface CallFinisher {
  /** Closes the recorder and hands its record on. Never throws. */
  finish(recorder: CallRecorder, outcome: Outcome): void;
  /** Writes the record when the stream settles. The stream itself is only observed. */
  observeStream(
    recorder: CallRecorder,
    result: CallResult,
    stream: { finalResult: PromiseLike<unknown> },
  ): void;
}

export function createCallFinisher(
  guard: Guard,
  emit: (record: CallLogRecord) => void,
): CallFinisher {
  const finish: CallFinisher['finish'] = (recorder, outcome) => {
    const record = guard('finish', () => recorder.finish(outcome), undefined);
    if (record) emit(record);
  };

  const observeStream: CallFinisher['observeStream'] = (recorder, result, stream) => {
    try {
      void stream.finalResult.then(
        (value) =>
          finish(recorder, {
            kind: 'result',
            result: { value, meta: result.meta, cache: result.cache },
          }),
        (error: unknown) => finish(recorder, { kind: 'error', error }),
      );
    } catch (error) {
      guard.report('observeStream', error);
      // Nothing will ever settle this call, so record it as it stands rather than lose it.
      finish(recorder, { kind: 'result', result });
    }
  };

  return { finish, observeStream };
}
