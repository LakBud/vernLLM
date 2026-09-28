import { assertSupportedImageMimeType } from '../internal/imageFormat.js';

import type { ContentBlock, LLMClient } from '../../types/index.js';
import type { OpenAIContentPart } from './types.js';

/** Translates `ContentBlock[]` into OpenAI content parts, images as inline `data:` URLs. */
function toOpenAIContent(blocks: ContentBlock[]): OpenAIContentPart[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? {
          type: 'image_url',
          image_url: {
            url: `data:${assertSupportedImageMimeType(block.mimeType)};base64,${block.data}`,
          },
        }
      : { type: 'text', text: block.text },
  );
}

/** Translates wire `messages` into OpenAI's shape, the one part of a request that isn't passed through. */
export function toOpenAIMessages(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
): unknown[] {
  return params.messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return { ...m, content: toOpenAIContent(m.content) };
    }

    if (m.role === 'tool') {
      const { is_error: isError, ...openAIToolMessage } = m;
      // OpenAI's tool message has no error field, so the failure is kept in
      // the content itself rather than dropped, or the model would read a
      // failed tool's output as a success.
      return isError
        ? { ...openAIToolMessage, content: `Error: ${openAIToolMessage.content}` }
        : openAIToolMessage;
    }

    // Only Claude understands reasoning blocks; OpenAI rejects unknown message fields.
    if (m.role === 'assistant' && m.thinking) {
      const { thinking: _thinking, ...openAIAssistantMessage } = m;
      return openAIAssistantMessage;
    }

    return m;
  });
}

/**
 * OpenAI rejects `json_object` unless a message mentions "json", and VernLLM
 * defaults `jsonMode` to `true`, so a short system instruction is prepended
 * when no message does.
 */
export function ensureJsonKeyword(
  messages: unknown[],
  responseFormat: Parameters<LLMClient['chat']['completions']['create']>[0]['response_format'],
): unknown[] {
  if (responseFormat?.type !== 'json_object') return messages;

  // Only text is checked: base64 image data can contain "json" by chance,
  // which would skip the instruction while OpenAI still rejects the call.
  const mentionsJson = messages.some((m) => {
    const content = (m as { content?: unknown }).content;
    const parts = Array.isArray(content) ? content : [content];

    return parts.some((part) => {
      const text = typeof part === 'string' ? part : (part as { text?: unknown } | null)?.text;
      return typeof text === 'string' && /json/i.test(text);
    });
  });

  return mentionsJson
    ? messages
    : [{ role: 'system', content: 'Respond with a valid JSON object.' }, ...messages];
}
