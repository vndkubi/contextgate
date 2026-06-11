---
name: trace-bug
description: "Trace an exact bug from concrete failure evidence using native narrow reads by default."
argument-hint: "<failing test, stack trace, error output, repro steps, file, class, function, or behavior>"
agent: agent
---

Trace the provided bug using exact evidence. Return JSON.

TokenOpt routing:
- If a file, class, function, line, failing test, stack frame, or exact behavior is provided, use native narrow search/read directly.
- Do not call ContextGate first for exact bug tracing; it usually double-spends.
- If stack trace/build/test output is long, use tokenopt_failure_packet first, then narrow read the suggested slices.
- If no concrete bug artifact is provided, ask for failing test, stack trace/error output, repro steps, expected vs actual behavior, or target symbol.

JSON keys: status, acquisition_path, bug_summary, evidence_chain, suspected_root_cause, affected_files, targeted_fix_location, verification, missing_items.
