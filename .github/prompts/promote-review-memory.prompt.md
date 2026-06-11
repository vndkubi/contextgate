---
name: promote-review-memory
description: "Extract reusable review-memory candidates from completed task evidence."
argument-hint: "<completed task summary, transcript, diff, or review outcome>"
agent: agent
---

Identify what should be promoted into review memory after a completed task. Return JSON.

TokenOpt routing:
- Require completed-task evidence: summary, transcript, diff, review findings, or final outcome.
- If completed-task evidence is missing, do not inspect the repo. Ask for that evidence.
- Promote only stable, reusable facts. Avoid stale branch-specific details.

JSON keys: status, memory_candidates, expiry_or_refresh, excluded_items, missing_items, rationale.
