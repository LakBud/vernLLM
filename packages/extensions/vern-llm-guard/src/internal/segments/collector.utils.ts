import type { Segment } from '../../types/index.js';
import type { Extracted, Path } from './types.js';

export interface Collector {
  extracted: Extracted;
  add(source: Segment['source'], text: string, path: Path, fixed?: boolean): void;
}

export function collector(): Collector {
  const extracted: Extracted = { segments: [], paths: [], fixed: [], unscanned: 0 };
  return {
    extracted,
    add(source, text, path, fixed = false) {
      // Nothing to find in no text, and nothing to write back.
      if (text.length === 0) return;
      extracted.segments.push({ text, source });
      extracted.paths.push(path);
      extracted.fixed.push(fixed);
    },
  };
}
