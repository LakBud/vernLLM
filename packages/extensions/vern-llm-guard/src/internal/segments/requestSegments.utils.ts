import { collector, type Collector } from './collector.utils.js';

import type { Extracted } from './types.js';
import type { WireMessage } from 'vern-llm';

type MessageOf<Role extends WireMessage['role']> = Extract<WireMessage, { role: Role }>;

/** A message whose content is one string, or else is not scanned. */
function plain(
  source: 'system' | 'tool',
  message: MessageOf<'system' | 'tool'>,
  at: number,
  { add, extracted }: Collector,
): void {
  if (typeof message.content === 'string') add(source, message.content, [at, 'content']);
  else extracted.unscanned++;
}

function user(message: MessageOf<'user'>, at: number, { add, extracted }: Collector): void {
  const { content } = message;
  if (typeof content === 'string') return add('user', content, [at, 'content']);
  if (!Array.isArray(content)) {
    extracted.unscanned++;
    return;
  }
  content.forEach((block, blockIndex) => {
    if (block.type === 'text') add('user', block.text, [at, 'content', blockIndex, 'text']);
    else extracted.unscanned++;
  });
}

function assistant(message: MessageOf<'assistant'>, at: number, { add }: Collector): void {
  if (typeof message.content === 'string') add('assistant', message.content, [at, 'content']);
  message.tool_calls?.forEach((call, callIndex) => {
    const path = [at, 'tool_calls', callIndex, 'function', 'arguments'];
    add('assistant', call.function.arguments, path);
  });
}

/**
 * Cuts the wire messages into segments: each system message, user text and text block, assistant
 * text, tool call arguments and tool result. `thinking` blocks are signed by providers and never
 * touched. Images are counted as unscanned.
 */
export function requestSegments(messages: readonly WireMessage[]): Extracted {
  const parts = collector();

  messages.forEach((message, index) => {
    if (message.role === 'user') user(message, index, parts);
    else if (message.role === 'assistant') assistant(message, index, parts);
    else plain(message.role, message, index, parts);
  });

  return parts.extracted;
}
