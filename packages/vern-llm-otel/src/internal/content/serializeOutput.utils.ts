import { isToolCallResult } from 'vern-llm';

import { isNonEmpty, stringify, toArguments } from './json.utils.js';
import { createTextPiece } from './textPiece.utils.js';

import type { Part, ResolvedCapture } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

const UNSERIALIZABLE_OUTPUT = '[unserializable output]';

/** A tools enabled call wraps a plain answer as `{ type: 'content', content }`. */
function unwrapContent(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { type?: unknown; content?: unknown };
    if (candidate.type === 'content' && 'content' in candidate) return candidate.content;
  }
  return value;
}

/**
 * The result as `gen_ai.output.messages`. The spec requires a finish reason on every message
 * and VernLLM does not expose the provider's, so it is inferred: `tool_call` for a tool call
 * result and `stop` otherwise.
 */
export function serializeOutput(
  value: unknown,
  capture: ResolvedCapture,
  guard: Guard,
): string | undefined {
  const piece = createTextPiece(capture, guard);
  const parts: Part[] = [];
  const answer = unwrapContent(value);
  let finishReason = 'stop';

  const addText = (text: string): void => {
    const cut = piece(text);
    if (isNonEmpty(cut)) parts.push({ type: 'text', content: cut });
  };

  if (isToolCallResult(answer)) {
    finishReason = 'tool_call';
    if (typeof answer.content === 'string') addText(answer.content);

    for (const call of answer.toolCalls) {
      const raw = stringify(call.arguments);
      const cut = raw === undefined ? undefined : piece(raw);
      parts.push({
        type: 'tool_call',
        id: call.id,
        name: call.name,
        ...(cut === undefined ? {} : { arguments: toArguments(cut) }),
      });
    }
  } else {
    const text = typeof answer === 'string' ? answer : stringify(answer);
    if (text === undefined) parts.push({ type: 'text', content: UNSERIALIZABLE_OUTPUT });
    else addText(text);
  }

  return stringify([{ role: 'assistant', parts, finish_reason: finishReason }]);
}
