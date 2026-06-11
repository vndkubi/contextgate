---
name: field-impact
description: "Analyze impact of changing a field, schema, property, or API contract."
argument-hint: "<field/schema/property/API name>"
agent: agent
---

Analyze the impact of changing the provided field/schema/property/API contract. Return JSON.

TokenOpt routing:
- This is an exact impact task; prefer native narrow search/read around the named field or contract.
- Use TokenOpt only for broad business/context summary if needed before exact impact work.
- Cite producers, consumers, validation, persistence, API contracts, tests, and migration risks.

JSON keys: status, target, producers, consumers, validation, persistence, api_contracts, tests, migration_risks, evidence_used.
