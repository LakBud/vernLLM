import type { ImageSegment, Segment } from '../../types/index.js';
import type { Extracted, InputSegment, Path } from './types.js';

export interface Collector {
  extracted: Extracted<InputSegment>;
  add(source: Segment['source'], text: string, path: Path, fixed?: boolean): void;
  /** An image is never rewritten, so it is always fixed. */
  addImage(source: ImageSegment['source'], image: ImageSegment['image'], path: Path): void;
}

export function collector(): Collector {
  const extracted: Extracted<InputSegment> = { segments: [], paths: [], fixed: [], unscanned: 0 };
  return {
    extracted,
    add(source, text, path, fixed = false) {
      // Nothing to find in no text, and nothing to write back.
      if (text.length === 0) return;
      extracted.segments.push({ text, source });
      extracted.paths.push(path);
      extracted.fixed.push(fixed);
    },
    addImage(source, image, path) {
      extracted.segments.push({ image, source });
      extracted.paths.push(path);
      extracted.fixed.push(true);
    },
  };
}
