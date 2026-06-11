---
name: security-audit
description: "Run a security-focused review only when concrete diff/scope is provided."
argument-hint: "<diff, PR, changed files, route, symbol, or risky surface>"
agent: agent
---

Perform a security-focused review of the provided changed behavior or risky surface. Return JSON findings.

TokenOpt routing:
- Use security_audit route.
- Require concrete diff/scope before findings.
- Security coverage must consider target/scope, input boundaries, auth/authz, validation/deserialization, secrets/config/dependencies, and tests/guardrails.
- If scope is missing, do not broad-search. Ask for the diff, PR, changed files, route, symbol, or risky surface.
- Use exact followups only; never use broad shell review fallback.

JSON keys: status, findings, evidence_used, missing_coverage, non_findings, next_steps.
