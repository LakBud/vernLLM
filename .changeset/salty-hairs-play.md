---
'vern-llm': patch
---

`getBackoffDelay` now uses full jitter instead of equal jitter for retry backoff delays.

The computed delay is now randomized anywhere between zero and the full exponential value,
`random() * exp`, instead of `exp / 2 + random() * (exp / 2)`. AWS's own analysis found full
jitter does less client work and completes retries faster than equal jitter under contention,
since it spreads retries over a wider window instead of clustering them in the top half of the
range. See [Exponential Backoff and
Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).

This changes the actual delay values retries wait for, but not the retry logic itself, no
options or public API changed.
