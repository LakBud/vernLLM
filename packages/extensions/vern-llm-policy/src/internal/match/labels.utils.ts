import { LabelsUnknownError, PatternError } from './errors.js';
import { read } from './value.utils.js';

import type { Matcher } from './types.js';

/** A label, or a list that must all be present. Unknown labels are not an answer. */
export function compileLabels(value: unknown, path: string): Matcher {
  const wanted = Array.isArray(value) ? value : [value];
  if (wanted.length === 0 || !wanted.every((label) => typeof label === 'string' && label !== '')) {
    throw new PatternError(`${path} must be a label, or a non empty list of labels`);
  }

  return (facts) => {
    const labels = read(facts, 'labels');
    if (!Array.isArray(labels)) throw new LabelsUnknownError();
    return wanted.every((label) => labels.includes(label));
  };
}
