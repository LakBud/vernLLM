import {
  isToolCallResult,
  type PreDispatchContext,
  type WireCallRequest,
  type WireMessage,
  type WireTool,
} from 'vern-llm';

import { ATTR } from './semconv.js';

import type { Guard } from './guard.js';
import type { ResolvedCapture } from './options.js';
import type { ContentCapture } from './tracker.js';
import type { Attributes, Span } from '@opentelemetry/api';

// Content is opt in and can hold personal data, so every decision here fails closed: when
// something cannot be checked, redacted, or serialized, that piece is left out.

export const TRUNCATION_MARKER = '…[truncated]';
/** Image bytes are never recorded, only the fact that there was an image. */
export const IMAGE_PLACEHOLDER = '[image]';
const UNSERIALIZABLE_OUTPUT = '[unserializable output]';

interface TextPart {
  type: 'text';
  content: string;
}
interface ToolCallPart {
  type: 'tool_call';
  id?: string;
  name: string;
  arguments?: unknown;
}
interface ToolCallResponsePart {
  type: 'tool_call_response';
  id?: string;
  response?: string;
}
type Part = TextPart | ToolCallPart | ToolCallResponsePart;

interface InputMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: Part[];
}

export interface CapturedInput {
  inputMessages?: string;
  systemInstructions?: string;
  toolDefinitions?: string;
}

/**
 * Cuts `text` to `maxLength` UTF-16 units without splitting a surrogate pair, and appends a
 * marker only when something was cut.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  let end = Math.max(0, maxLength);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;

  return text.slice(0, end) + TRUNCATION_MARKER;
}

/**
 * One allowance per captured attribute, shared by every piece of text going into it, so the
 * attribute as a whole stays under `maxLength` however many messages it holds.
 */
function createBudget(maxLength: number) {
  let remaining = maxLength;

  return {
    take(text: string): string {
      if (text.length <= remaining) {
        remaining -= text.length;
        return text;
      }

      const cut = truncate(text, remaining);
      remaining = 0;
      return cut;
    },
  };
}

/**
 * Redacts and then budgets one piece of text. `undefined` means the piece must be left out:
 * a redactor that throws or returns something other than a string never lets the original
 * text through.
 */
function createTextPiece(
  capture: ResolvedCapture,
  guard: Guard,
): (text: string) => string | undefined {
  const budget = createBudget(capture.maxLength);
  const { redact } = capture;

  return (text) => {
    let value = text;

    if (redact) {
      const redacted = guard<unknown>('captureContent.redact', () => redact(text), undefined);
      if (typeof redacted !== 'string') return undefined;
      value = redacted;
    }

    return budget.take(value);
  };
}

function stringify(value: unknown): string | undefined {
  try {
    // Undefined for a value JSON cannot represent, and a throw for a cycle or a BigInt.
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Tool arguments arrive as a JSON string. Structured when it parses, the string otherwise. */
function toArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isNonEmpty(text: string | undefined): text is string {
  return text !== undefined && text !== '';
}

function toInputMessage(
  message: Exclude<WireMessage, { role: 'system' }>,
  piece: (text: string) => string | undefined,
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
    const piece = createTextPiece(capture, guard);
    const parts: TextPart[] = [];

    for (const message of request.messages) {
      if (message.role !== 'system') continue;
      const value = piece(message.content);
      if (isNonEmpty(value)) parts.push({ type: 'text', content: value });
    }

    if (parts.length > 0) captured.systemInstructions = stringify(parts);
  }

  if (capture.input) {
    const piece = createTextPiece(capture, guard);
    const messages: InputMessage[] = [];

    for (let index = request.messages.length - 1; index >= 0; index--) {
      const message = request.messages[index]!;
      if (message.role !== 'system') messages.push(toInputMessage(message, piece));
    }

    if (messages.length > 0) captured.inputMessages = stringify(messages.reverse());
  }

  if (capture.toolDefinitions && request.tools && request.tools.length > 0) {
    captured.toolDefinitions = toToolDefinitions(request.tools, capture.maxLength);
  }

  return captured;
}

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

function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;

  try {
    return typeof (value as { then?: unknown }).then === 'function';
  } catch {
    // A `then` that throws when read is not something to trust as a plain answer.
    return true;
  }
}

/**
 * Decides once per call whether content is recorded. User code is not run when nothing could
 * be recorded anyway. Only a return value of exactly `true` enables capture: a throw, a
 * promise, or any other value means no.
 */
export function decideCapture(
  capture: ResolvedCapture,
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
  span: Span,
  guard: Guard,
): boolean {
  if (!capture.anyGroup || !span.isRecording()) return false;
  if (!capture.when) return true;

  const { when } = capture;
  const decision = guard<unknown>('captureContent.when', () => when(ctx, request), false);

  if (isThenable(decision)) {
    // Swallowed, so a rejecting promise does not also become an unhandled rejection.
    try {
      void Promise.resolve(decision).catch(() => {});
    } catch {
      // A hostile thenable that throws when observed is still just a refusal.
    }
    guard.report('captureContent.when', new Error('it must be synchronous but returned a promise'));
    return false;
  }

  return decision === true;
}

export function createContentCapture(capture: ResolvedCapture, guard: Guard): ContentCapture {
  return {
    decide: (ctx, request, span) => decideCapture(capture, ctx, request, span, guard),

    captureInput(span, request) {
      // Checked on the span being written to, because a custom sampler can decide differently
      // for the call span and each attempt span.
      if (!span.isRecording()) return;

      const input = serializeInput(request, capture, guard);
      const attributes: Attributes = {};
      if (input.inputMessages !== undefined) attributes[ATTR.inputMessages] = input.inputMessages;
      if (input.systemInstructions !== undefined) {
        attributes[ATTR.systemInstructions] = input.systemInstructions;
      }
      if (input.toolDefinitions !== undefined)
        attributes[ATTR.toolDefinitions] = input.toolDefinitions;

      span.setAttributes(attributes);
    },

    captureOutput(span, value) {
      if (!capture.output || !span.isRecording()) return;

      const output = serializeOutput(value, capture, guard);
      if (output !== undefined) span.setAttribute(ATTR.outputMessages, output);
    },
  };
}
