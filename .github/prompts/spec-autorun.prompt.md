---
name: spec-autorun
description: "Plan a SpecKit /autorun workflow with bounded phases and evidence reuse."
argument-hint: "<spec, feature, or workflow goal>"
agent: agent
---

Plan a SpecKit /autorun workflow with bounded phases, evidence reuse, and verification checkpoints. Return JSON.

TokenOpt routing:
- Use TokenOpt for broad planning only when it replaces exploration.
- Split the work into bounded phases with clear stop/verify points.
- Reuse evidence packets and avoid repeating the same searches across phases.

JSON keys: status, phases, evidence_reuse, checkpoints, validation, stop_conditions, risks.
