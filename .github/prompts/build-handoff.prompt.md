---
name: build-handoff
description: "Create a build/onboarding/daily handoff grounded in repo facts."
argument-hint: "<optional target module or handoff focus>"
agent: agent
---

Create a concise build/onboarding/daily handoff grounded in repository evidence. Return JSON.

TokenOpt routing:
- This is a broad repo handoff task; use tokenopt_compile_evidence once as a cost gate when available.
- If answerable=true, answer from the packet and do not gather redundant repo facts.
- Prefer copied package/build commands over inferred commands.

JSON keys: status, build_system, package_manager, key_commands, repo_map, fast_validation, risks, evidence_used.
