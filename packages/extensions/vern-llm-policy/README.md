<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-policy.png" alt="vern-llm-policy logo" width="96" />
</p>

<h1 align="center">vern-llm-policy</h1>

<p align="center">Rules for which providers and models a <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> call may use, and whether it may run at all.</p>

Rules like "EU data stays in the EU" or "this tenant requires zero data retention" are easy to get right on the first attempt and easy to break on a fallback, when a failing primary hands the call to a provider that was never allowed to see it. `vern-llm-policy` is one middleware that removes the targets a call may not use, or denies the call when none are left. It runs before usage and the router, so a denied call spends nothing, and a removed target can never come back through retries or fallback.

## Installation

```bash
npm i vern-llm-policy
```

`vern-llm` is a peer dependency, and the package has no other dependency.

## Quick start

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

A call with `context: { region: 'eu' }` only ever reaches `openai-eu`. A suspended tenant's call fails with `policy_denied` before any provider is contacted.

## What it does and does not do

| Policy does                                                | Policy does not                                          |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| Remove targets a call may not use, or deny the call        | Add a target, reorder targets, or choose a preferred one |
| Decide before usage, the router or any provider is reached | Read or filter the content of a call                     |
| Fail closed when a rule or a label cannot be evaluated     | Authenticate anyone, or check that `context` is true     |
| Record every decision with rule ids, never with call data  | Enforce a flag it hands to other middleware              |

Policy trusts the `context` you pass. Put the tenant, region, and plan there from your own authenticated session, not from user input.

## Why the rules are hard to get wrong

- **Order never matters.** Allows widen each other, forbids narrow, and a forbid always wins.
- **A missing fact never matches.** `forbid: { not: { region: 'eu' } }` also removes a target that declares no region.
- **Typos fail at construction.** An attribute no target declares is an error when the policy is built, so it can't become a rule that never matches.
- **Errors fail closed.** A rule that throws still applies its `forbid` by default.
- **Exceptions must expire.** Each one needs an `until` date and a reason, and is recorded on every decision it covered.
- **Updates are all or nothing.** `policy.update()` validates the whole policy first, so a mistake throws and the old policy keeps running.

## Usage

### Handling a denied call

```ts
import { LLMError } from 'vern-llm';

try {
  await llm.call({ userContent, jsonMode: false, context: { tenantStatus: 'suspended' } });
} catch (error) {
  if (error instanceof LLMError && error.code === 'policy_denied') {
    // error.issues.rules says which rules removed every target
    return refuse();
  }
  throw error;
}
```

A denial is never retried, never falls back, and never counts toward a circuit breaker. `issues` holds rule ids and target names, never a `context` value, so it is safe to log.

### Testing rules as plain data

`evaluate` gives the decision a call would get, with no provider, no network, and nothing emitted:

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

For a rollout on live traffic, set `mode: 'audit'` on a rule or the whole policy. An audit rule removes nothing and reports what it would have removed.

### Rules on what a call contains

With [`vern-llm-guard`](https://www.npmjs.com/package/vern-llm-guard), a rule can match on what the guard found in the text:

```ts
policyMiddleware({
  labels: guardLabels,
  rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
});
```

If the guard did not run, the labels are unknown and the `forbid` applies, so a missing or misordered guard never fails open on the rules that matter most.

### Flags for other middleware

`set` hands booleans to other middleware, such as `{ id: 'pii-zdr', set: { duplicateSends: false } }`, read with `policyFlags(ctx)`. Policy never enforces a flag: whatever reads it decides what it means.

Every call emits a `policy.decision` event with rule ids and target names, including denied calls and cache hits.

## Documentation

See the [policy docs](https://vernllm.dev/docs/extensions/policy) for [rules and patterns](https://vernllm.dev/docs/extensions/policy/features/rules), [exceptions](https://vernllm.dev/docs/extensions/policy/features/exceptions), [labels](https://vernllm.dev/docs/extensions/policy/features/labels), [caching](https://vernllm.dev/docs/extensions/policy/features/caching), [rollout](https://vernllm.dev/docs/extensions/policy/features/rollout), and [recipes](https://vernllm.dev/docs/extensions/policy/features/recipes).

## License

MIT
