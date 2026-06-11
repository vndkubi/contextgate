---
name: repo-benchmark-analysis
description: "Analyze a repository as a benchmark target with cost and task-class risks."
argument-hint: "<optional benchmark focus>"
agent: agent
---

Analyze this repository as a benchmark target: build facts, repo shape, likely task classes, and cost risks. Return JSON.

TokenOpt routing:
- This is a broad repo analysis task; use TokenOpt as a cost gate.
- Do not enumerate all files in model context; rely on bounded inventory/facts.
- Identify which task classes should use TokenOpt and which should bypass it.

JSON keys: status, build_facts, repo_shape, likely_task_classes, cost_risks, benchmark_suggestions, evidence_used.
