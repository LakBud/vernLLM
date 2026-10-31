---
'vern-llm-redis': patch
---

`fromNodeRedis` works with node-redis 5 and later, which only accept a string `SCAN` cursor.

The adapter sent a number, so with node-redis 6 the circuit breaker's startup scan failed with a logged `snapshot failed` warning, and a new process never learned about circuits already open elsewhere. It now sends the string cursor, which node-redis 4 also accepts, and turns the reply cursor into a string. `NodeRedisLike.scan` accepts both the node-redis 4 and the node-redis 5 and later shapes, so a client of either version type checks.

Passing a node-redis client to `fromNodeRedis` keeps compiling and behaving the same on node-redis 4. On node-redis 5 and later, startup seeding now works instead of logging a warning. Type level only: `NodeRedisLike.scan` is now a union of two function types, so code that calls `scan` directly on a `NodeRedisLike` value needs a cast.
