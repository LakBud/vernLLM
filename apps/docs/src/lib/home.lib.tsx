import * as React from 'react';

import { codeHighlightKeywords } from './home.utils';

/**
 * Splits the code example on vern-llm's own identifiers and wraps matches
 * in an orange span, so the library's surface area stands out against the
 * plain OpenAI/Zod/JS syntax around it.
 */
export function renderHighlightedCode(code: string) {
  const pattern = new RegExp(`\\b(${codeHighlightKeywords.join('|')})\\b`, 'g');
  return code.split(pattern).map((part, i) =>
    codeHighlightKeywords.includes(part) ? (
      <span key={i} className="text-fd-primary">
        {part}
      </span>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}
