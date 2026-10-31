<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-policy.png" alt="vern-llm-policy logo" width="96" />
</p>

<h1 align="center">vern-llm-policy</h1>

<p align="center">Rules for which providers and models a <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> call may use, and whether it may run at all.</p>

A middleware that removes targets a call is not allowed to use, or denies the call when none are left. It runs before usage and the router, so a denied call spends nothing, and a removed target can never come back through retries or fallback.

## Usage

```ts
import { VernLLM } from 'vern-llm';
import { policyMiddleware } from 'vern-llm-policy';

const policy = policyMiddleware({
  default: 'allow', // or 'deny': only targets some allow rule grants
  targets: {
    'openai-us': { region: 'us', zdr: false },
    'openai-eu': { region: 'eu', zdr: true },
    anthropic: { region: 'us', zdr: true },
  },
  rules: [
    { id: 'suspended', forbid: 'all', when: { context: { tenantStatus: 'suspended' } } },
    { id: 'eu-residency', forbid: { not: { region: 'eu' } }, when: { context: { region: 'eu' } } },
    { id: 'free-models', allow: { model: ['gpt-6-mini'] }, when: { context: { plan: 'free' } } },
  ],
});

const llm = new VernLLM({ client, model, fallback, middleware: [policy] });
```

## Rules

A rule has an `id`, at most one of `allow` and `forbid`, and at least one of `allow`, `forbid` and `set`.

- `allow`: only targets matching the pattern may be used while the rule applies
- `forbid`: matching targets are removed, or `'all'` to deny the call
- `set`: boolean flags for other middleware, see Flags
- `when`: the rule applies only when the call matches. Omitted means always
- `except`: time bound exceptions, see Exceptions

The result is the same whatever order the rules are in. Allows widen each other, forbids narrow, and a forbid always wins. With no applicable `allow`, `default` decides: every target, or none.

## Patterns

One matcher is used for target patterns and for `when`.

- `{ key: value }` matches when the fact equals the value, strictly
- `{ key: [a, b] }` matches any of them, and several keys must all match
- `{ not: pattern }` and `{ any: [p1, p2] }` combine patterns
- `(facts) => boolean` matches only when it returns `true`. It must not change `context`, which it reads through a read only view: a write throws, and counts as the rule failing

A missing fact never equals anything. So `{ region: 'eu' }` does not match a target that declares no region, while `{ not: { region: 'eu' } }` does. For residency, write `forbid: { not: { region: 'eu' } }` so undeclared targets are removed too.

Target facts are `name`, `model` (the effective model, a call's override included), `provider` (only when the adapter knows it) and everything you declare in `targets`. An attribute no target declares is an error when the policy is built, so a typo cannot become a rule that never matches.

Call facts for `when` are `context`, `labels`, `request` (`hasTools`, `jsonOutput`, `images`, `inputTokens`, `streaming`) and `callTargets`. `inputTokens` takes `{ gte, lte }` bounds.

## Denials

A denied call fails with an `invalid_params` error with code `policy_denied`, before any provider is contacted. It is never retried, never falls back and never counts toward a circuit breaker. `issues` holds the rule ids and the removed targets, and never a `context` value.

## Flags

`set` hands booleans to other middleware: `{ id: 'pii-zdr', set: { duplicateSends: false } }`. Flags from every applicable rule are merged and `false` wins, whatever the order. An audit rule sets none.

```ts
import { policyFlags } from 'vern-llm-policy';

// in any middleware inside policy, before next()
if (policyFlags(ctx).duplicateSends === false) {
  // send once
}
```

Policy never enforces a flag. Whatever reads it decides what it means. `policyFlags(ctx)` is `{}` when no rule set one.

## Labels

Rules can match on what the call contains, through a `labels` function that usually reads what an outer middleware stored, such as a content guard.

```ts
policyMiddleware({
  labels: (ctx) => ctx.state.get(guardFindings),
  rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
});
```

`when: { labels: ['pii', 'health'] }` needs all of them. The function runs once per call, and only when some rule reads labels or has a `when` function. Without a `labels` option, a rule that matches on labels is an error when the policy is built.

| It returns                | Means                  | A rule on labels         |
| ------------------------- | ---------------------- | ------------------------ |
| `['pii']`                 | checked, found these   | matches on what is there |
| `[]`                      | checked, found nothing | does not match           |
| `undefined`, or it throws | unknown                | follows `onError`        |

Keep `[]` and `undefined` apart: return `undefined` when the labeler did not run for the call. Closed, the default, then applies a `forbid`, so a missing or misordered guard never fails open on the rules that matter most. The decision says `labels: 'unknown'`, and a warning is logged once.

## Exceptions

`except` lifts a rule for some calls, for a while.

```ts
{
  id: 'eu-residency',
  forbid: { not: { region: 'eu' } },
  except: [
    { when: { context: { tenantId: 'acme' } }, until: '2026-11-01', reason: 'DPA signed, migration pending' },
  ],
}
```

- `until` is required, so an exception always expires. A date ends at midnight UTC, or give a date and time with an offset. It is exclusive. A date that does not exist, such as `2026-02-31`, is an error
- An exception that covered a call is in the decision with its reason
- An expired one is ignored, and warned about once
- It lifts only its own rule. Other forbids still apply
- If its `when` throws, it covers nothing, whatever `onError` says

## Testing rules

`evaluate` gives the decision a call would get, from plain data. No provider, no network, nothing emitted.

```ts
const decision = policy.evaluate({
  context: { region: 'eu' },
  targets: [
    { name: 'openai-us', model: 'gpt-6' },
    { name: 'openai-eu', model: 'gpt-6' },
  ],
});

expect(decision.removed).toEqual({ 'openai-us': 'eu-residency' });
```

`request` takes the facts rules read and defaults the rest to `false` or `0`. An unknown or mistyped fact throws. `labels` is what the labeler would return, and leaving it out means unknown. `now` sets the moment, which decides whether an exception has ended.

## Changing rules

`update` replaces the rules, targets, default, version and every other setting except the logger.

```ts
policy.update({ version: '2026-10-24.2', targets, rules });
```

It is validated completely first, so a mistake throws and the old policy keeps running. A call that already started keeps the policy it started with, and each decision carries the `version` that made it. Leave a setting out and it goes back to its default, so pass everything.

## Caching

A `cachedCall` that joins another caller's call shares its answer, and the core ignores the joiner's narrowing. Policy still runs for the joiner and can deny it, but it cannot change which targets the shared call used.

When target rules differ by tenant or region, put that attribute in the `cacheKey`.

If a join is answered by a target the joiner's rules removed, policy emits `policy.cross_join` with the target and the rule, and warns once per rule. A cache hit has nothing to compare, so it is not checked.

## Errors

A pattern or `when` function that throws is handled by `onError`. Each failing rule is reported once through the logger with its error name, and every distinct failure is listed in `Decision.errors` with its full message. The logger and the event carry the kind of error only, since a message may hold call data.

- `'closed'` (default): a `forbid` still applies, and an `allow` grants nothing. A `forbid` whose pattern throws on one target removes only that target
- `'open'`: the rule is skipped. An `allow` that throws is dropped entirely, so no allow list stays in force

If the policy itself fails, `'closed'` denies the call with `policy_denied` and `'open'` runs it untouched.

A rule with only `set` and a `when` that throws still sets its flags when closed, since an unknown condition is treated as met.

Declared `targets` names are compared with the targets of the first call, and one that matches nothing is warned about once. It is advice: a middleware ahead of policy that narrows targets can make it wrong.

## Audit mode

Set `mode: 'audit'` on a rule, or on the whole policy, to see what a rule would do without enforcing it. An audit rule removes nothing and never denies a call. The decision lists the targets it would have removed, on top of the rules that are enforced. A rule's own `mode` wins over the policy's.

With `mode: 'audit'` and `default: 'deny'`, the default is reported under the key `'default'`, so the rule id `default` is reserved.

## Decision event

Every call emits a `policy.decision` event before anything inside the policy runs, including denied calls and cache hits.

```ts
{ v: 1, version?, outcome: 'allowed' | 'narrowed' | 'denied', removed, flags, exceptions, audit, errors, labels? }
```

`flags` maps each flag that is `false` to the rule that set it, `exceptions` lists the ones that applied, `errors` lists `{ rule, name }` for each failure, and `labels` is the labels the call had, or `'unknown'`.

It holds rule ids, target names and kinds of error, never a `context` value, an error message or request content. Set `version` to tag decisions with the revision of your rules, which also appears in the `issues` of a denial.
