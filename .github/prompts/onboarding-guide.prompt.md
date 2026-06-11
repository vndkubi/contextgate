---
name: onboarding-guide
description: "Create a concise onboarding guide grounded in repo evidence."
argument-hint: "<optional audience or module>"
agent: agent
---

Create a concise onboarding guide grounded in repository evidence. Return JSON sections and citations.

TokenOpt routing:
- This is a broad repo task; use TokenOpt as a cost gate for build facts, repo shape, docs, and quick validation.
- Do not inspect exact source files unless the onboarding target names a specific module.
- Prefer verified setup and test commands from repo files.

JSON keys: status, audience, setup, repo_map, common_workflows, verification, risks, evidence_used.
