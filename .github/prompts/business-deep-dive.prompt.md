---
name: business-deep-dive
description: "Study a product, business, or domain area from repo evidence."
argument-hint: "<business area, domain term, product capability, or repo scope>"
agent: agent
---

Study the provided business/domain area from repository evidence. Return JSON.

TokenOpt routing:
- This is usually a broad repo/domain task, so use TokenOpt as a cost gate when it can replace broad exploration.
- If the requested area is named, require evidence tied to that target before answerable=true.
- If exact line-level flow proof is needed, switch to native narrow search/read for that exact flow.

JSON keys: status, business_summary, actors, concepts, glossary, flows, evidence_used, gaps, next_steps.
