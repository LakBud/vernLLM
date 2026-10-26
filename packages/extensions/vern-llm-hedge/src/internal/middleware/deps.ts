import type { ResolvedConfig } from '../../types/index.js';
import type { Adapt } from '../adapt.js';
import type { HedgeBudget } from '../budget.js';
import type { CacheAware } from '../cacheAware.js';
import type { Delay } from '../delay/delay.utils.js';
import type { Guard } from '../guard.utils.js';
import type { MiddlewareStateKey } from 'vern-llm';

/** Everything one hedge instance shares across its calls. */
export interface HedgeDeps {
  config: ResolvedConfig;
  guard: Guard;
  budget: HedgeBudget;
  adapt: Adapt | undefined;
  cacheAware: CacheAware | undefined;
  delay: Delay;
  /** Per instance, so it can never collide with another instance or a key of the user's. */
  prefixKey: MiddlewareStateKey<string>;
}
