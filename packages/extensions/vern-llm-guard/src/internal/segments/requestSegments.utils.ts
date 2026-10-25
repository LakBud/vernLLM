import { collector } from './collector.utils.js';

import type { Extracted } from './types.js';
import type { WireMessage } from 'vern-llm';

/**
 * Cuts the wire messages into segments: each system message, user text and text block, assistant
 * text, tool call arguments and tool result. `thinking` blocks are signed by providers and never
 * touched. Images are counted as unscanned.
 */
export function requestSegments(messages: readonly WireMessage[]): Extracted {
  const { extracted, add } = collector();

  /** A message whose content is one string, or else is not scanned. */
  const text = (
    source: 'system' | 'assistant' | 'tool',
    message: WireMessage,
    at: number,
  ): void => {
    if (typeof message.content === 'string') add(source, message.content, [at, 'content']);
    else extracted.unscanned++;
  };

  const user = (message: WireMessage & { role: 'user' }, at: number): void => {
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
  };

  const assistant = (message: WireMessage & { role: 'assistant' }, at: number): void => {
    if (typeof message.content === 'string') add('assistant', message.content, [at, 'content']);
    message.tool_calls?.forEach((call, callIndex) => {
      add('assistant', call.function.arguments, [
        at,
        'tool_calls',
        callIndex,
        'function',
        'arguments',
      ]);
    });
  };

  messages.forEach((message, index) => {
    if (message.role === 'user') user(message, index);
    else if (message.role === 'assistant') assistant(message, index);
    else text(message.role, message, index);
  });

  return extracted;
}
