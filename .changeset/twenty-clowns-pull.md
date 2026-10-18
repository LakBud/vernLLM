---
'vern-llm-redis': minor
---

`redisCircuitBreaker` keeps working while Redis is unreachable. The first Redis call that fails, or is still pending after `prepareTimeoutMs`, switches the process to core's in-process `CircuitBreaker`, built from the same options and starting closed, so a circuit can still open from this process's own failures. Its changes fire `onStateChange` and the `circuit_state` event. Calls keep going to Redis without claiming a trial slot, and the first one that answers switches back to the shared state.

Before, a failed transition left the local copy as it was, so a closed circuit could never open during an outage.
