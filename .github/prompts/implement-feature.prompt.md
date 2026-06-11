---
name: implement-feature
description: "Implement or plan a concrete feature with targeted validation."
argument-hint: "<feature/PBI/spec text and optional target module>"
agent: agent
---

Implement or plan the provided feature using the smallest safe change. Return JSON if planning; edit files only if explicitly asked.

TokenOpt routing:
- If the owning file/module is known, use native narrow search/read and targeted validation.
- If the owning area is unknown and full-mode coding tools are available, use coding_coverage once.
- Do not accept coding answerability without exact target, signature/definition, dependencies/usages, test neighbor/style, and build/test command.

JSON keys: status, scope, target_files, implementation_steps, tests, validation, risks, missing_items.
