import type { ImageSegment } from '../../types/index.js';
import type { InputSegment } from './types.js';

/** Whether a segment is an image, which has no text to read. */
export const isImage = (segment: InputSegment): segment is ImageSegment => 'image' in segment;
