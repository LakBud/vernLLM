import type { Logger } from '../logger.js';
import type { VernLLMMiddleware } from '../types/middleware.js';

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
}

/**
 * `name`, or the entry's own array index. Deliberately not
 * `middlewareLabel`'s bracketed display form. Used both as the graph
 * key inside `buildNodes` (against the original, pre-sort `entries`
 * order) and, via `buildMiddlewarePipeline`'s `names`, as the resolved
 * label for an already-ordered array (against `transformOrder`
 * position). Exported so a call site that already has a
 * `MiddlewarePipeline`-ordered array in hand (see
 * `attemptLoop.utils.ts`) can derive the identical labels
 * `names` already holds, instead of inventing a second way to compute
 * them.
 */
export function idFor(entry: VernLLMMiddleware, index: number): string {
  return entry.name ?? String(index);
}

/**
 * A middleware's resolved position in the graph: its id, its entry, its
 * original array index (the tie break once `priority` is also equal),
 * and the ids of every entry that must come after it. Built once per
 * `resolveMiddlewareOrder` call in a single pass over `entries`, so
 * collecting edges and warning about unknown references never walk the
 * input twice for the same data.
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
 * Resolves one `runsAfter`/`runsBefore` reference into a `mustPrecede`
 * edge on the graph, or warns and drops it if `targetId` isn't a known
 * entry. Pulled out of `buildNodes` so edge resolution (this) is
 * testable independently of node/index construction.
 */
function resolveReference(
  byId: Map<string, Node>,
  knownIds: Set<string>,
  fromId: string,
  targetId: string,
  precedes: boolean,
  logger?: Logger,
): void {
  if (!knownIds.has(targetId)) {
    logger?.warn?.(
      `middleware "${fromId}" references unknown name "${targetId}" in runsAfter/runsBefore, ignoring it`,
    );
    return;
  }
  // precedes true: targetId (runsAfter) must come before fromId.
  // precedes false: targetId (runsBefore) must come after fromId.
  const before = precedes ? targetId : fromId;
  const after = precedes ? fromId : targetId;
  byId.get(before)!.mustPrecede.push(after);
}

function buildNodes(entries: readonly VernLLMMiddleware[], logger?: Logger): Node[] {
  const ids = entries.map(idFor);
  const knownIds = new Set(ids);
  const nodes = entries.map((entry, index): Node => ({
    id: ids[index]!,
    entry,
    index,
    mustPrecede: [],
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    for (const target of node.entry.runsAfter ?? []) {
      resolveReference(byId, knownIds, node.id, target, true, logger);
    }
    for (const target of node.entry.runsBefore ?? []) {
      resolveReference(byId, knownIds, node.id, target, false, logger);
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
 * Kahn's algorithm over `nodes`' `mustPrecede` edges, ties among
 * simultaneously-ready nodes broken by `byPriorityThenIndex`. Doubles
 * as cycle detection: a valid DAG always drains the ready queue down to
 * every node, so if any are left unvisited once it's empty, they and
 * everything reachable among them form a cycle. This replaces a
 * separate DFS pass that used to check for cycles before this ran;
 * Kahn's already proves acyclicity as a side effect of ordering, so
 * doing both was one full extra walk of the same graph for the same
 * answer. Throws a plain `Error`, not `LLMError`, since a cycle is a
 * construction-time config mistake the caller made, not a failure that
 * came from a call.
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
 * Sorts `entries` once, at `VernLLM` construction time. With no
 * `runsAfter`/`runsBefore` anywhere, this is exactly today's flat
 * `priority` sort, ascending, ties by original index, and skips graph
 * construction entirely. With edges present, resolves them first via
 * Kahn's algorithm over an adjacency list built once up front, and only
 * falls back to `priority` then original index to break ties among
 * nodes with no constraint between them at a given step.
 */
export function resolveMiddlewareOrder(
  entries: readonly VernLLMMiddleware[],
  logger?: Logger,
): VernLLMMiddleware[] {
  assertNoDuplicateLabels(entries);

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
 * Stable sort: `'outermost'` entries move to the front, `'innermost'` to
 * the back. Everything else stays in the middle group; a numeric
 * `position` there sorts like `priority` (ascending), but only for
 * `wrapOrder`, ties broken by `transformOrder` position since `sort` is
 * stable. Entries with no `position` at all default to `0`, so they
 * interleave with numeric-positioned entries rather than always sorting
 * after them. Multiple `'outermost'` claimants keep their relative
 * order, so the first one registered holds the true outermost slot.
 */
function applyPositionOverride(order: readonly VernLLMMiddleware[]): VernLLMMiddleware[] {
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
  return [...outermost, ...sortedMiddle, ...innermost];
}

/**
 * Builds the one `MiddlewarePipeline` a `VernLLM` instance uses for its
 * whole lifetime. Called once, in the constructor. Nothing downstream,
 * `runOperation.ts`, `middleware.utils.ts`, `circuitBreakerContext.ts`,
 * computes order itself; each reads the field it needs off this object.
 */
export function buildMiddlewarePipeline(
  entries: readonly VernLLMMiddleware[],
  logger?: Logger,
): MiddlewarePipeline {
  const transformOrder = resolveMiddlewareOrder(entries, logger);
  return {
    transformOrder,
    wrapOrder: applyPositionOverride(transformOrder),
    names: Object.freeze(transformOrder.map(idFor)),
  };
}
