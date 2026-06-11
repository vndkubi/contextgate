---
name: flow-trace
description: "Trace an exact code/API/business flow with line-level evidence."
argument-hint: "<flow name, endpoint, entrypoint, class, or behavior>"
agent: agent
---

Trace the provided flow end to end and cite exact evidence. Return JSON unless the user asks for Mermaid.

TokenOpt routing:
- If the prompt names an entrypoint, endpoint, class, route, or exact behavior, use native narrow search/read directly.
- Do not call ContextGate first for line-level flow proof; it usually double-spends.
- If the owner is unknown and the task is broad flow discovery, use TokenOpt once, then exact followups only.

JSON keys: status, acquisition_path, entrypoints, ordered_steps, files_and_symbols, unknown_edges, tests, evidence_used.
