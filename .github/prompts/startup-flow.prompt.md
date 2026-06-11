---
name: startup-flow
description: "Trace application startup/bootstrap flow or debug startup failure."
argument-hint: "<application/module, startup failure, stack trace, or config target>"
agent: agent
---

Trace startup/bootstrap flow or debug the provided startup failure. Return JSON.

TokenOpt routing:
- For exact startup flow tracing with known entrypoint/config, use native narrow search/read.
- For long stack traces/build logs, use tokenopt_failure_packet to extract exact files/lines before bounded reads.
- If no startup artifact or target is provided, ask for entrypoint, config, stack trace, or failing command.

JSON keys: status, acquisition_path, entrypoint, initialization_order, config_loading, failure_points, targeted_verification, evidence_used.
