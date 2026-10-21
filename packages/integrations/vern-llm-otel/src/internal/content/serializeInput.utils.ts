import { isNonEmpty, stringify, stringifyWithinRedacted, toArguments } from './json.utils.js';
import { createTextPiece, type TextPiece } from './textPiece.utils.js';

import type { InputMessage, Part, ResolvedCapture, TextPart } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { WireCallRequest, WireMessage, WireTool } from 'vern-llm';

/** Image bytes are never recorded, only the fact that there was an image. */
export const IMAGE_PLACEHOLDER = '[image]';

export interface CapturedInput {
  inputMessages?: string;
  systemInstructions?: string;
  toolDefinitions?: string;
}

function toInputMessage(
  message: Exclude<WireMessage, { role: 'system' }>,
  piece: TextPiece,
): InputMessage {
  const parts: Part[] = [];
  const addText = (text: string): void => {
    const value = piece(text);
    if (isNonEmpty(value)) parts.push({ type: 'text', content: value });
  };

  switch (message.role) {
    case 'user':
      if (typeof message.content === 'string') {
        addText(message.content);
      } else {
        for (const block of message.content) {
          if (block.type === 'text') addText(block.text);
          else parts.push({ type: 'text', content: IMAGE_PLACEHOLDER });
        }
      }
      return { role: 'user', parts };

    case 'assistant':
      if (message.content) addText(message.content);
      for (const call of message.tool_calls ?? []) {
        const raw = piece(call.function.arguments);
        parts.push({
          type: 'tool_call',
          id: call.id,
          name: call.function.name,
          ...(raw === undefined ? {} : { arguments: toArguments(raw) }),
        });
      }
      return { role: 'assistant', parts };

    case 'tool': {
      const response = piece(message.content);
      parts.push({
        type: 'tool_call_response',
        id: message.tool_call_id,
        ...(response === undefined ? {} : { response }),
      });
      return { role: 'tool', parts };
    }
  }
}

function toToolDefinitions(tools: readonly WireTool[], maxLength: number): string | undefined {
  const full = stringify(
    tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  );
  if (full !== undefined && full.length <= maxLength) return full;

  // The spec advises against filling optional properties when the attribute would be large,
  // so the next step down keeps only the required ones. Each step is still valid JSON.
  const minimal = stringify(tools.map((tool) => ({ type: 'function', name: tool.function.name })));
  return minimal !== undefined && minimal.length <= maxLength ? minimal : undefined;
}

/**
 * The request as the three input attributes. System messages become system instructions, and
 * only the groups that are enabled are produced. Each attribute has its own length budget, and
 * the input messages spend theirs on the newest messages first, since a long history is read
 * for what was asked last.
 */
export function serializeInput(
  request: Readonly<WireCallRequest>,
  capture: ResolvedCapture,
  guard: Guard,
): CapturedInput {
  const captured: CapturedInput = {};

  if (capture.systemInstructions) {
    const json = stringifyWithinRedacted(capture.maxLength, (budget, redacted) => {
      const piece = createTextPiece(capture, guard, budget, redacted);
      const parts: TextPart[] = [];

      for (const message of request.messages) {
        if (message.role !== 'system') continue;
        const value = piece(message.content);
        if (isNonEmpty(value)) parts.push({ type: 'text', content: value });
      }

      return parts.length > 0 ? parts : undefined;
    });
    if (json !== undefined) captured.systemInstructions = json;
  }

  if (capture.input) {
    const json = stringifyWithinRedacted(capture.maxLength, (budget, redacted) => {
      const piece = createTextPiece(capture, guard, budget, redacted);
      const messages: InputMessage[] = [];

      // Newest first, and stops once the allowance is spent, so older messages are dropped
      // whole rather than kept as empty or marker only entries.
      for (let index = request.messages.length - 1; index >= 0; index--) {
        const message = request.messages[index]!;
        if (message.role === 'system') continue;
        if (piece.exhausted()) break;
        messages.push(toInputMessage(message, piece));
      }

      return messages.length > 0 ? messages.reverse() : undefined;
    });
    if (json !== undefined) captured.inputMessages = json;
  }

  if (capture.toolDefinitions && request.tools && request.tools.length > 0) {
    captured.toolDefinitions = toToolDefinitions(request.tools, capture.maxLength);
  }

  return captured;
}
