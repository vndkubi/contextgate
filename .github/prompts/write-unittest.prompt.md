---
name: write-unittest
description: "Plan or write focused unit tests for a concrete class/module/behavior."
argument-hint: "<target class/module/file and behavior>"
agent: agent
---

Plan or write focused unit tests for the provided target and behavior. Return JSON unless the user asks for code edits.

TokenOpt routing:
- Require a concrete target class, module, file, behavior, or failing case.
- If the target is missing, do not search the repo to guess it. Ask for the target/behavior.
- If the target exists and TokenOpt full-mode coding tools are available, use coding_coverage once.
- For write_unittest, use at most one additional allowed MCP followup after compile_evidence.

JSON keys: status, target, behavior, test_location, test_cases, fixtures_or_mocks, assertions, targeted_command, missing_items.
