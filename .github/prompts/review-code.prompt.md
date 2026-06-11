---
name: review-code
description: "Review concrete code diffs with bounded evidence and compact findings."
argument-hint: "<diff, PR, changed files, or exact review target>"
agent: agent
---

Review the provided code diff/scope. Prioritize correctness, regressions, missing tests, security, and performance. Return JSON findings.

TokenOpt routing:
- Diff-first and scope-first.
- If no diff, PR, changed files, file path, symbol, or exact target is provided, do not explore the repo. Ask for the review artifact.
- When concrete diff/scope exists, use review_diff evidence and exact bounded followups only.
- Avoid style nits unless they affect behavior.

JSON keys: status, findings, evidence_used, missing_scope, non_findings, suggested_tests.
