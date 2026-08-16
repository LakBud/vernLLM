---
'vern-llm': patch
---

The internal logger is now wrapped so a throwing custom logger can no longer break the call it was logging about. If a user-supplied logger.debug, logger.warn, or logger.error throws, the error is caught and dropped, and the original operation still completes normally.
