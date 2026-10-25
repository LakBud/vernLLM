import type { CallRecorder } from './callRecorder.js';
import type { VernLLMEvent } from 'vern-llm';

/** Maps one event to a change on the recorder. `circuit_state` is handled by the caller. */
export function applyEvent(
  recorder: CallRecorder,
  event: VernLLMEvent,
  keepCustomEvent: (name: string) => boolean,
): void {
  switch (event.kind) {
    case 'rate_limited':
      recorder.queued(event.waitedMs);
      return;
    case 'retry':
      recorder.retried(event.delayMs, event.error, event.chain);
      return;
    case 'fallback':
      recorder.fellBack(event.elapsedMs, event.error, event.chain);
      return;
    case 'circuit_state':
      recorder.noteBreaker({
        provider: event.provider,
        model: event.model,
        from: event.from,
        to: event.to,
      });
      return;
    case 'middleware': {
      const note = { kind: event.hook, name: event.middleware } as const;
      recorder.noteMiddleware(
        event.patchedFields ? { ...note, patchedFields: [...event.patchedFields] } : note,
      );
      return;
    }
    case 'usage':
      recorder.setUsage(event.usage, false, event.chain);
      return;
    case 'usage_failure':
      recorder.setUsage(event.usage, true, event.chain);
      return;
    case 'custom':
      if (keepCustomEvent(event.name)) recorder.addCustom(event.name, event.data);
      return;
  }
}
