---
name: performance-analysis
description: "Analyze likely performance hotspots with measurement-first optimization guidance."
argument-hint: "<hotspot, workflow, query, endpoint, or module>"
agent: agent
---

Analyze likely performance hotspots and propose measurement-first optimizations. Return JSON.

TokenOpt routing:
- If no hotspot/target is named, use TokenOpt for broad repo evidence and clearly mark hypotheses.
- If an endpoint/query/module is named, use native narrow search/read around that exact path.
- Do not propose fixes without measurement and targeted validation.

JSON keys: status, target, suspected_hotspots, measurements, optimization_options, validation, risks, evidence_used.
