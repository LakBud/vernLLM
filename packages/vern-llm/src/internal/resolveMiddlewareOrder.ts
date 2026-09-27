import {
  middlewareContextNames,
  middlewareLabel,
  middlewareLabels,
  type MiddlewareContextNames,
} from './utils/middlewareLabels.utils.js';

import type { Logger } from '../logger.js';
import type {
  MiddlewareRef,
  RequiredMiddlewareRef,
  VernLLMMiddleware,
} from '../types/middleware.js';

export { middlewareContextNames, middlewareLabel, middlewareLabels, type MiddlewareContextNames };

/**
 * Every resolved view of middleware order, built once at `VernLLM`
 * construction time. Nothing downstream computes order itself; each
 * consumer reads the one field it needs.
 */
export interface MiddlewarePipeline {
  /** `transform`/`onEvent` order: `priority`, `runsAfter`/`runsBefore` resolved, ties by original index. */
  transformOrder: VernLLMMiddleware[];
  /** `wrap` nesting order: `transformOrder` with any `position` pins applied. Identical to `transformOrder` when nothing sets `position`. */
  wrapOrder: VernLLMMiddleware[];
  /** Every entry's resolved label, in `transformOrder`, frozen. Powers `registeredMiddlewareNames` on context. */
  names: readonly string[];
  /** `names` narrowed to entries that define a `transform`, frozen. Powers `transformMiddlewareNames` on context. */
  transformNames: readonly string[];
}

/** `name`, or the array index. Not the bracketed display label: this is the ordering graph's id. */
export function idFor(entry: VernLLMMiddleware, index: number): string {
  return entry.name ?? String(index);
}

/**
 * Throws if two entries publish the same label. Graph ids can differ while labels clash, e.g. one
 * named `"[1]"` and an unnamed entry at position 1.
 */
function assertNoDuplicatePublishedLabels(labels: readonly string[]): void {
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      throw new Error(
        `middleware has a duplicate label "${label}"; a name can't match an unnamed middleware's bracketed position`,
      );
    }
    seen.add(label);
  }
}

/**
 * One entry in the ordering graph: its id, entry, original index for tie breaks, and the ids that
 * must come after it.
 */
interface Node {
  id: string;
  entry: VernLLMMiddleware;
  index: number;
  /** Ids of entries that must be placed after this one. Kahn's algorithm walks this directly instead of rescanning a flat edge list on every pop. */
  mustPrecede: string[];
}

/** Throws if two entries resolve to the same `idFor` label. Duplicate labels would silently merge two middleware into one `Node` in `buildNodes`, corrupting edges and `registeredMiddlewareNames`. */
function assertNoDuplicateLabels(entries: readonly VernLLMMiddleware[]): void {
  const ids = entries.map(idFor);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(
        `middleware ordering has a duplicate name "${id}"; every middleware's resolved name must be unique`,
      );
    }
    seen.add(id);
  }
}

/**
 * Throws if two entries share a `ref`. Runs even when no entry has edges, so a duplicate can't sit
 * unnoticed until an edge targets it.
 */
function assertNoDuplicateRefs(entries: readonly VernLLMMiddleware[]): void {
  const seen = new Map<MiddlewareRef, number>();
  entries.forEach((entry, index) => {
    const ref = entry.ref;
    if (!ref) return;
    const firstIndex = seen.get(ref);
    if (firstIndex !== undefined) {
      throw new Error(
        `middleware ordering has a ref reused across two entries ("${idFor(entries[firstIndex]!, firstIndex)}" and "${idFor(entry, index)}"); each middleware's ref must be unique to that middleware`,
      );
    }
    seen.set(ref, index);
  });
}

/**
 * Splits a `runsAfter` or `runsBefore` entry into its ref and whether it is required. Only
 * `requireRef` output has a `ref` property.
 */
function unwrapReference(target: MiddlewareRef | RequiredMiddlewareRef): {
  ref: MiddlewareRef;
  required: boolean;
} {
  return 'ref' in target ? { ref: target.ref, required: true } : { ref: target, required: false };
}

/**
 * Turns one `runsAfter` or `runsBefore` entry into a graph edge, matched by ref identity, never by
 * `name`. An unresolved bare ref warns and is dropped; an unresolved required ref throws.
 */
function resolveReference(
  byId: Map<string, Node>,
  byRef: Map<MiddlewareRef, Node>,
  fromId: string,
  target: MiddlewareRef | RequiredMiddlewareRef,
  precedes: boolean,
  logger?: Logger,
): void {
  const { ref, required } = unwrapReference(target);
  const targetNode = byRef.get(ref);

  if (!targetNode) {
    if (required) {
      throw new Error(
        `middleware "${fromId}" requires ref "${ref.debugName}", which is not registered; this dependency is not optional`,
      );
    }

    logger?.warn?.(
      `[VernLLM] middleware "${fromId}" references unknown ref "${ref.debugName}" in runsAfter/runsBefore, ignoring it`,
    );

    return;
  }
  // precedes true: target (runsAfter) must come before fromId.
  // precedes false: target (runsBefore) must come after fromId.
  const before = precedes ? targetNode.id : fromId;
  const after = precedes ? fromId : targetNode.id;
  byId.get(before)!.mustPrecede.push(after);
}

function buildNodes(entries: readonly VernLLMMiddleware[], logger?: Logger): Node[] {
  const ids = entries.map(idFor);
  const nodes = entries.map((entry, index): Node => ({
    id: ids[index]!,
    entry,
    index,
    mustPrecede: [],
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Only entries with a `ref` can be targeted, keyed by the ref object so labels never affect
  // order. Refs are already known to be unique here.
  const byRef = new Map(
    nodes.filter((node) => node.entry.ref).map((node) => [node.entry.ref!, node]),
  );

  for (const node of nodes) {
    for (const target of node.entry.runsAfter ?? []) {
      resolveReference(byId, byRef, node.id, target, true, logger);
    }
    for (const target of node.entry.runsBefore ?? []) {
      resolveReference(byId, byRef, node.id, target, false, logger);
    }
  }

  return nodes;
}

/** Ascending by `priority` (default `0`), ties broken by original array index. */
function byPriorityThenIndex(a: Node, b: Node): number {
  const priorityDiff = (a.entry.priority ?? 0) - (b.entry.priority ?? 0);
  return priorityDiff !== 0 ? priorityDiff : a.index - b.index;
}

/**
 * Kahn's algorithm, ties broken by `byPriorityThenIndex`. Nodes left unvisited form a cycle, so
 * this is also the cycle check. Throws a plain `Error`, since a cycle is a construction time
 * mistake.
 */
function topologicalSort(nodes: Node[]): VernLLMMiddleware[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    for (const after of node.mustPrecede) indegree.set(after, indegree.get(after)! + 1);
  }

  // A small heap would beat re-sorting the ready set on every pop for a
  // large graph, but middleware lists are small in practice; re-sorting
  // a handful of ready ids each iteration is simpler and fast enough.
  const ready = nodes.filter((node) => indegree.get(node.id) === 0);
  const result: VernLLMMiddleware[] = [];
  const emitted = new Set<string>();

  while (ready.length > 0) {
    ready.sort(byPriorityThenIndex);
    const node = ready.shift()!;
    result.push(node.entry);
    emitted.add(node.id);

    for (const afterId of node.mustPrecede) {
      const remaining = indegree.get(afterId)! - 1;
      indegree.set(afterId, remaining);
      if (remaining === 0) ready.push(byId.get(afterId)!);
    }
  }

  if (result.length < nodes.length) {
    const stuck = nodes.filter((node) => !emitted.has(node.id)).map((node) => node.id);
    throw new Error(`middleware ordering has a cycle among: ${stuck.join(', ')}`);
  }

  return result;
}

/**
 * Sorts `entries` once, at construction. Without `runsAfter` or `runsBefore` this is a plain
 * `priority` sort, ties by index; with edges it runs the graph sort.
 */
export function resolveMiddlewareOrder(
  entries: readonly VernLLMMiddleware[],
  logger?: Logger,
): VernLLMMiddleware[] {
  assertNoDuplicateLabels(entries);
  assertNoDuplicateRefs(entries);

  const hasEdges = entries.some((entry) => entry.runsAfter?.length || entry.runsBefore?.length);

  if (entries.length <= 1 && !hasEdges) return [...entries];

  if (!hasEdges) {
    // Same comparator the graph path uses for tie-breaking among
    // simultaneously-ready nodes, so "what does a tie mean" has one
    // definition regardless of which path an entry set takes.
    const asNodes = entries.map((entry, index): Node => ({
      id: idFor(entry, index),
      entry,
      index,
      mustPrecede: [],
    }));
    return asNodes.sort(byPriorityThenIndex).map((node) => node.entry);
  }

  const nodes = buildNodes(entries, logger);
  return topologicalSort(nodes);
}

/**
 * Stable sort for `wrapOrder`: `'outermost'` first, `'innermost'` last, numeric or missing (`0`)
 * positions in between like `priority`. Among several outermost claimants the first registered is
 * outermost; among innermost claimants the last registered is innermost.
 */
function applyPositionOverride(
  order: readonly VernLLMMiddleware[],
  entries: readonly VernLLMMiddleware[],
): VernLLMMiddleware[] {
  const outermost: VernLLMMiddleware[] = [];
  const innermost: VernLLMMiddleware[] = [];
  const middle: VernLLMMiddleware[] = [];

  // Single pass instead of three separate `.filter()` walks over
  // `order`; each entry lands in exactly one bucket, so there's no risk
  // of the buckets' predicates drifting out of sync with each other as
  // position values are added later.
  for (const entry of order) {
    if (entry.position === 'outermost') outermost.push(entry);
    else if (entry.position === 'innermost') innermost.push(entry);
    else middle.push(entry);
  }

  const sortedMiddle = [...middle].sort((a, b) => {
    const aPos = typeof a.position === 'number' ? a.position : 0;
    const bPos = typeof b.position === 'number' ? b.position : 0;
    return aPos - bPos;
  });
  // Registration order, not `order`'s: `order` is sorted by priority, which would let a
  // claimant's `transform` priority decide who wraps whom.
  const registered = (a: VernLLMMiddleware, b: VernLLMMiddleware): number =>
    entries.indexOf(a) - entries.indexOf(b);
  outermost.sort(registered);
  innermost.sort(registered);

  return [...outermost, ...sortedMiddle, ...innermost];
}

/**
 * Builds the one `MiddlewarePipeline` an instance uses. Nothing downstream computes order itself.
 */
export function buildMiddlewarePipeline(
  entries: readonly VernLLMMiddleware[],
  logger?: Logger,
): MiddlewarePipeline {
  const transformOrder = resolveMiddlewareOrder(entries, logger);
  const { registeredMiddlewareNames: names, transformMiddlewareNames: transformNames } =
    middlewareContextNames(transformOrder);
  assertNoDuplicatePublishedLabels(names);
  return {
    transformOrder,
    wrapOrder: applyPositionOverride(transformOrder, entries),
    names,
    transformNames,
  };
}
