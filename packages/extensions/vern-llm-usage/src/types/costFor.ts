import type { WireCallRequest } from 'vern-llm';

/**
 * A function that prices a request on a target, in USD. The contract a router can take, so it
 * needs no import of this package: any function of this shape works, and `usage.costFor` is one.
 * Returns `undefined` when it cannot price the target, and never throws.
 */
export type CostFor = (
  target: { name: string; model: string },
  request: Readonly<WireCallRequest>,
) => number | undefined;
