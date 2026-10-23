import { createMiddlewareStateBag, stateEntry, type PreDispatchContext } from 'vern-llm';

import { routerRouteKey } from '../../stateKeys.js';

import type { PreviewInput, ResolvedConfig } from '../../types/index.js';

/** A context for a call that has not been made, built from the instance's own targets. */
export function previewContext(
  config: ResolvedConfig,
  input: PreviewInput,
  now: number,
): PreDispatchContext {
  if (!config.health) {
    throw new Error('routerMiddleware: preview needs the health option to know the targets');
  }
  const source = config.health();
  if (!source) {
    throw new Error('routerMiddleware: preview needs health to return the VernLLM instance');
  }

  const adapter = { name: 'custom' };
  const declared = source.getCircuitStates().map((entry) => ({
    name: entry.provider,
    index: entry.index,
    model: input.request.model,
    adapter,
  }));
  const targets = input.targets
    ? input.targets.map((name) => {
        const found = declared.find((target) => target.name === name);
        if (!found) throw new Error(`routerMiddleware: preview names no target "${name}"`);
        return found;
      })
    : declared;

  return {
    stage: 'pre-dispatch',
    requestId: 'preview',
    capabilities: {},
    state: createMiddlewareStateBag(
      input.route === undefined ? [] : [stateEntry(routerRouteKey, input.route)],
    ),
    // A preview emits nothing, so this only completes the shape.
    /* v8 ignore next */
    emit: () => undefined,
    context: input.context,
    streaming: input.streaming === true,
    callTargets: input.targets,
    deadlineAt: input.deadlineMs === undefined ? undefined : now + input.deadlineMs,
    targets,
  } as unknown as PreDispatchContext;
}
