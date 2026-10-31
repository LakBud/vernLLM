import { collector, type Collector } from './collector.utils.js';

import type { Extracted, Path } from './types.js';

const MAX_DEPTH = 64;

/** The parts of a tool call that name it and are not text. */
const CALL_IDENTITY: ReadonlySet<string> = new Set(['id', 'name']);

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Tool calls: everything but their ids and names is text. */
function walkCalls(
  parts: Collector,
  calls: unknown[],
  path: Path,
  depth: number,
  fixed: boolean,
): void {
  calls.forEach((call, index) => {
    const at = [...path, index];
    if (!isPlain(call)) return walkNode(parts, call, at, depth + 2, fixed);
    for (const field of Object.keys(call)) {
      if (!CALL_IDENTITY.has(field)) walkNode(parts, call[field], [...at, field], depth + 2, fixed);
    }
  });
}

/** One key of an object: what a wrapper keeps apart from its text is handled here. */
function walkEntry(
  parts: Collector,
  node: Record<string, unknown>,
  key: string,
  path: Path,
  depth: number,
  fixed: boolean,
): void {
  const child = node[key];
  const at = [...path, key];
  const wrapper = node.type === 'content' || node.type === 'tool_calls';

  if (wrapper && key === 'type') return;
  if (wrapper && key === 'thinking') return walkNode(parts, child, at, depth + 1, true);
  if (node.type === 'tool_calls' && key === 'toolCalls' && Array.isArray(child)) {
    return walkCalls(parts, child, at, depth, fixed);
  }
  walkNode(parts, child, at, depth + 1, fixed);
}

function walkNode(
  parts: Collector,
  node: unknown,
  path: Path,
  depth: number,
  fixed: boolean,
): void {
  const { add, extracted } = parts;
  if (typeof node === 'string') return add('output', node, path, fixed);
  if (typeof node !== 'object' || node === null) return;
  if (depth >= MAX_DEPTH) {
    extracted.unscanned++;
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkNode(parts, item, [...path, index], depth + 1, fixed));
    return;
  }
  if (!isPlain(node)) return;

  for (const key of Object.keys(node)) walkEntry(parts, node, key, path, depth, fixed);
}

/**
 * Cuts a call's answer into segments: its text, and every string inside JSON or tool call
 * arguments. Nothing is skipped because of its shape: in JSON mode the model writes the whole
 * object, so a key that looks like one of the core's wrappers must not hide anything. Only the
 * `type` of a wrapper and the ids and names of tool calls are left out, since they are not text.
 * A wrapper's `thinking` blocks are scanned but marked fixed, so they are never rewritten.
 */
export function outputSegments(value: unknown): Extracted {
  const parts = collector();
  walkNode(parts, value, [], 0, false);
  // Nothing of an answer is an image.
  return parts.extracted as Extracted;
}
