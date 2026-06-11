---
name: requirement-analysis
description: "Analyze a concrete requirement into WHAT, WHY, HOW, acceptance criteria, tests, and unknowns."
argument-hint: "<paste requirement text or ticket URL>"
agent: agent
---

Analyze the provided requirement. Return JSON with WHAT, WHY, HOW, acceptance criteria, impacted areas, tests, and unknowns.

TokenOpt routing:
- If the requirement text or ticket URL is missing, do not inspect the repo. Return bounded JSON asking for the requirement artifact.
- Do not invent repo-specific evidence when the requirement is absent.
- When artifact exists, use TokenOpt only for broad repo evidence that replaces exploration.

JSON keys: status, what, why, how, acceptance_criteria, impacted_areas, tests, unknowns, evidence_used.
