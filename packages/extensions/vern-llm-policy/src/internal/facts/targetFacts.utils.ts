import type { TargetFacts } from '../../types/options.js';
import type { CompiledPolicy } from '../../types/resolvedConfig.js';
import type { TargetInfo } from 'vern-llm';

/** A ceiling against a runaway model name. */
const MAX_CACHED_TARGETS = 512;

const targetFactsCache = new WeakMap<CompiledPolicy, Map<string, TargetFacts>>();

/**
 * What a target pattern sees: declared attributes plus `name`, `model` and `provider`, which is
 * left out when the adapter does not know it. Cached per name, model and provider.
 */
export function targetFacts(policy: CompiledPolicy, target: TargetInfo): TargetFacts {
  let cached = targetFactsCache.get(policy);
  if (!cached) {
    cached = new Map();
    targetFactsCache.set(policy, cached);
  }

  const provider = target.adapter.provider;
  const key = `${target.name}\u0000${target.model}\u0000${provider ?? ''}`;

  let facts = cached.get(key);
  if (!facts) {
    if (cached.size >= MAX_CACHED_TARGETS) cached.clear();

    const declared = Object.hasOwn(policy.declared, target.name)
      ? policy.declared[target.name]
      : undefined;
    facts = Object.freeze({
      ...declared,
      name: target.name,
      model: target.model,
      ...(provider !== undefined && { provider }),
    });
    cached.set(key, facts);
  }
  return facts;
}
