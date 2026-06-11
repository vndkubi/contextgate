---
name: spec-feature-plan
description: "Specify or plan a feature from repo/domain evidence with acceptance criteria."
argument-hint: "<feature idea, spec text, or acceptance criteria>"
agent: agent
---

Specify or plan the provided feature from repo/domain evidence and produce acceptance criteria. Return JSON.

TokenOpt routing:
- If feature/spec text is missing, ask for it instead of exploring.
- If provided, use TokenOpt for broad repo/domain evidence and exact followups only for named targets.
- Keep implementation, tests, validation, and unknowns explicit.

JSON keys: status, feature_summary, domain_evidence, acceptance_criteria, implementation_outline, tests, unknowns, evidence_used.
