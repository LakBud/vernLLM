import { createStateKey } from 'vern-llm';

/**
 * Forces a route for one call, skipping route matching. For tests and support overrides:
 * `state: [stateEntry(routerRouteKey, 'bulk')]`. A name that matches no route warns once and
 * falls back to matching.
 */
export const routerRouteKey = createStateKey<string>('router.route');
