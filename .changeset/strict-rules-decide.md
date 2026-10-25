---
'vern-llm-policy': minor
---

First release of `vern-llm-policy`, a middleware that decides which providers and models a call may use, and whether it may run at all.

`policyMiddleware({ rules })` runs before usage and the router, so a denied call spends nothing and a removed target can never come back through retries or fallback. A rule has an `allow` or a `forbid` pattern over target facts (`name`, `model`, `provider` and attributes you declare in `targets`, such as `region` or `zdr`), an optional `when` over the call, and `forbid: 'all'` to deny the call. Allows add up, forbids narrow, a forbid always wins and the order of rules never matters. A call left with no target fails with `policy_denied`, before any provider is contacted. A typo in an attribute name is an error when the policy is built.

`when` reads the call's `context`, its request (`hasTools`, `jsonOutput`, `images`, `inputTokens`, `streaming`), `callTargets` and `labels`. A `labels` function supplies content labels, usually from a guard: `[]` means nothing was found, and `undefined` or a throw means unknown, which follows `onError` so a missing labeler fails closed.

`set` hands boolean flags to other middleware, merged with `false` winning and read with `policyFlags(ctx)`. `except` lifts a rule for some calls until a required date, and the decision records why. `onError` is `closed` by default, so a rule that throws still forbids, and a failure of the policy itself denies the call.

`mode: 'audit'`, per rule or for the whole policy, reports what a rule would remove without enforcing it, to try a policy on live traffic first. Every call emits a `policy.decision` event before it goes on, with rule ids, target names and the kind of any error, never a `context` value or an error message.

`policy.evaluate({ context, targets, request, labels, now })` returns the decision a call would get from plain data, for table driven tests. `policy.update({ rules, ... })` validates a whole new policy and swaps it atomically, and every decision carries its `version`. A `cachedCall` that joins another caller's call is still decided on, and `policy.cross_join` reports a join answered by a target the joiner's rules removed.
