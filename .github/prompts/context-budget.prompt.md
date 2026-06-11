---
name: context-budget
description: "Inspect context budget risks and recommend compaction checkpoints."
argument-hint: "<optional workflow, task, or repo area>"
agent: agent
---

Inspect context budget risks and recommend compaction/checkpoint strategy. Return JSON.

TokenOpt routing:
- Use TokenOpt for broad repo shape and cost-risk evidence.
- Do not read large raw files unless a concrete budget driver is named.
- Recommend checkpoints based on evidence, not generic advice.

JSON keys: status, budget_drivers, risky_workflows, compaction_checkpoints, reuse_candidates, missing_items, evidence_used.
