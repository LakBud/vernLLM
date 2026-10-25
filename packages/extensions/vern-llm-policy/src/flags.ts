import { createStateKey, type PreDispatchContext } from 'vern-llm';

const NONE: Readonly<Record<string, boolean>> = Object.freeze({});

/** Module level so a reader does not need the policy instance. */
export const policyFlagsKey = createStateKey<Readonly<Record<string, boolean>>>('policy.flags');

/**
 * The flags the policy set for this call, `false` winning, or `{}`. Read it before `next()`:
 * `if (policyFlags(ctx).duplicateSends === false) ...`. Policy never enforces a flag.
 */
export function policyFlags(ctx: PreDispatchContext): Readonly<Record<string, boolean>> {
  return ctx.state.get(policyFlagsKey) ?? NONE;
}
