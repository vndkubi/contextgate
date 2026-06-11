---
name: refactor-scope
description: "Scope a refactor/migration with impacted usages, contracts, config, and tests."
argument-hint: "<symbol, API, migration, resource, package, or behavior>"
agent: agent
---

Scope the provided refactor or migration. Return impacted definitions, usages, contracts, config, tests, and risks as JSON.

TokenOpt routing:
- If the refactor target is exact, use native narrow search/read for definitions and usages.
- Use TokenOpt for broader impact planning only when it can replace repo-wide exploration.
- Keep output as a plan unless the user explicitly asks for edits.

JSON keys: status, target, definitions, usages, contracts, config, tests, migration_risks, validation_plan, evidence_used.
