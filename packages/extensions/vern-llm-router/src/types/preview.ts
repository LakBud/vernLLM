import type { CallContext, WireCallRequest } from 'vern-llm';

/** What `router.preview()` needs to decide as a call would. */
export interface PreviewInput {
  /** The request to route. Its `model` stands in for every target's model when pricing. */
  request: Readonly<WireCallRequest>;
  /** The call's `context`, for routes that match on it. */
  context?: CallContext;
  /** Whether the call would stream. Default `false`. */
  streaming?: boolean;
  /** The call's `deadlineMs`, counted from now. */
  deadlineMs?: number;
  /** Force a route by name, like `routerRouteKey`. */
  route?: string;
  /** The call's own `targets`: the answer is then `pinned`. */
  targets?: readonly string[];
}
