---
name: pbi-plan
description: "Create a compatibility-preserving implementation plan from a concrete PBI or requirement."
argument-hint: "<paste PBI/requirement text, ticket URL, or acceptance criteria>"
agent: agent
---

Create an implementation plan for the provided PBI/requirement while preserving compatibility. Return JSON.

TokenOpt routing:
- If no concrete PBI, requirement body, issue URL, or acceptance criteria is provided, do not explore the repo. Ask for the missing artifact in JSON.
- If a concrete artifact is provided, use TokenOpt as a cost gate only when it can replace broad exploration.
- Keep any followup exact and bounded.

JSON keys: status, requirement_summary, impacted_areas, implementation_plan, tests, compatibility_risks, missing_items, next_steps.
