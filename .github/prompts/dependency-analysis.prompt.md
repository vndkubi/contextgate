---
name: dependency-analysis
description: "Analyze dependency/build graph risks and targeted verification."
argument-hint: "<dependency, package, module, conflict, or build symptom>"
agent: agent
---

Analyze dependency/build risks and propose targeted verification. Return JSON.

TokenOpt routing:
- Use TokenOpt for broad build facts and dependency context when the target is not exact.
- If a concrete dependency/config/file is named, use native narrow search/read around that artifact.
- Avoid lockfile reads unless they are necessary for the stated dependency question.

JSON keys: status, dependency_scope, build_files, risks, verification_commands, missing_items, evidence_used.
