---
'vern-llm': patch
---

`buildStreamResult` now bounds its streamed `tool_call_delta` accumulator. `toolCallAcc` accepts at
most 10,000 distinct tool-call indices, and each entry retains at most 1,000,000 argument
characters. Both checks run before inserting a new map entry or appending to an existing argument
string, so a misbehaving provider cannot grow either structure without limit.

Exceeding either limit throws `LLMError('validation')` through the existing stream failure path.
The iterator is cleaned up, the stream is aborted, and both `chunks` and `finalResult` observe the
normalized failure instead of allowing the accumulator to continue consuming provider output.
