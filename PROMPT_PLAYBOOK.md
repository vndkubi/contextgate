# TokenOpt Prompt Playbook

This guide shows how to prompt agents so TokenOpt, CodeGraph, and native search/read are used only when they reduce context cost.

## Core Rule

Do not force TokenOpt first for every task.

Use the cheapest evidence path:

```text
Broad repo/business/planning task -> TokenOpt cost gate.
Exact code/call graph task -> CodeGraph.
Known file/class task -> native narrow search/read.
Review current diff -> diff/review context first.
Never repeat the same evidence acquisition with TokenOpt + CodeGraph + shell.
```

## What The Agent Should Report

Add this contract when you want to audit whether the agent chose the right path:

```text
Start your answer with:
Acquisition path: TokenOpt MCP | CodeGraph | native narrow search/read | diff context
Reason:
Fallback used: yes/no
```

If the answer says `Acquisition path: TokenOpt MCP` and then performs broad shell search or CodeGraph for the same evidence, that is a failed run.

## Standard Cost Router Prefix

Use this prefix for most natural tasks:

```text
Choose the cheapest evidence path first.

If this is a broad repo/business/planning task and TokenOpt MCP is available, use TokenOpt as a cost gate:
- Call tokenopt_compile_evidence once.
- If answerable=true, answer from the packet and do not call shell/search/read/CodeGraph again for the same evidence.
- If answerable=false, use only its allowed TokenOpt followups.

If this is an exact code-flow/class/method/PBI task that needs line-level proof, do not call TokenOpt first. Use CodeGraph or narrow search/read directly.

Never do TokenOpt first and then repeat the same exploration with shell, search, or CodeGraph.

Start the answer with:
Acquisition path:
Reason:
Fallback used:

Task:
<your real task>
```

## When To Mention TokenOpt

| Situation | Mention TokenOpt? | Prompt guidance |
| --- | --- | --- |
| Broad repo overview, handoff, business summary | Optional after setup; mention if Copilot ignores MCP | `Use TokenOpt as a cost gate if it can replace broad exploration.` |
| Benchmarking TokenOpt | Yes | `Use TokenOpt as the first acquisition path for this benchmark.` |
| Copilot does not call MCP naturally | Yes | `Use the tokenopt-cost-gate agent if available.` |
| Exact flow/class/method trace | Usually no | Use CodeGraph or narrow search/read directly. |
| Known file/module implementation | Usually no | Start from the known file/module and run narrow validation. |
| Review current diff | Usually no | Use diff context first; use CodeGraph only for unclear impact. |

## When To Mention CodeGraph

Use CodeGraph when exact code structure matters:

- Owning class/function/module discovery.
- Call graph and dependency graph.
- API/service/domain flow with line-level proof.
- Impact analysis from a specific symbol or field.
- Implementation where the owning code path is unknown.

Do not call CodeGraph after TokenOpt if TokenOpt already returned `answerable=true`.

## Prompt Samples

### 1. Business Deep Dive

Use this when the user wants business understanding, glossary, and business flow.

```text
Choose the cheapest evidence path first.

This is a broad business/domain understanding task. If TokenOpt MCP is available, use tokenopt_compile_evidence once as a cost gate.
If answerable=true, answer from the packet and do not call shell/search/read/CodeGraph again.
If answerable=false, use only allowed TokenOpt followups.

Task:
Study the <business area> business in this repo.
Explain the business flow, business concepts, glossary, actors, states, and evidence-backed gaps.
Cite concrete repo evidence.

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 2. Business Deep Dive When Copilot Ignores MCP

```text
Use the tokenopt-cost-gate agent if available.

Choose the cheapest evidence path first:
- Broad business/domain task -> TokenOpt MCP once.
- Exact code-flow task -> CodeGraph or narrow search/read directly.
- Never TokenOpt first plus shell fallback.

Task:
Study the <business area> business in this repo.
Explain business flow, concepts, glossary, actors, states, and cite evidence.
```

### 3. Exact Existing Flow Trace

Use this when line-level code proof is required. Do not force TokenOpt first.

```text
This is an exact code-flow trace that needs line-level proof.
Do not call TokenOpt first.
Use CodeGraph if available for call graph/symbol ownership; otherwise use narrow search/read only.
Avoid broad repo scans.

Task:
Trace the <flow name> flow end to end.
Start from the likely entrypoint, follow service/domain/storage/external calls, cite files and symbols, and produce a Mermaid sequence diagram.

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 4. Investigate PBI

```text
Choose the cheapest evidence path first.

For this PBI, first decide:
- Broad requirement/business understanding -> use TokenOpt MCP once.
- Exact affected classes/functions/call graph -> use CodeGraph.
- Known files/classes -> native narrow search/read.
- Do not use TokenOpt and CodeGraph both unless the first path cannot answer.

PBI:
<paste PBI>

Return:
1. What the PBI is asking
2. Why it matters
3. Impacted business flow
4. Likely impacted code areas
5. Risks and unknowns
6. Acceptance criteria
7. Recommended next investigation steps

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 5. Implementation Plan

```text
Choose the cheapest evidence path first.

Use TokenOpt for broad implementation planning if it can summarize repo evidence cheaply.
Use CodeGraph only if exact owning modules/classes/call graph are needed.
Avoid TokenOpt + CodeGraph + shell double-spend.

Task:
Create an implementation plan for this requirement:
<paste requirement>

Return:
- Scope
- Out of scope
- Impacted files/modules
- Step-by-step implementation
- Test plan
- Risks
- Rollback/compatibility notes
```

### 6. WHAT / WHY / WHEN / HOW / Scenarios

```text
Choose the cheapest evidence path first.

This is requirement analysis. Use TokenOpt if broad repo/business evidence is enough.
Use CodeGraph only for exact flow or symbol ownership.

Requirement:
<paste requirement>

Explain:
- WHAT needs to change
- WHY it is needed
- WHEN it applies
- HOW the system should behave
- Main scenarios
- Edge cases
- Acceptance criteria
- Evidence from repo/code/docs

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 7. Implement Code + Unit Tests

Use this for actual code changes. Do not force TokenOpt first if the owning file/module is known.

```text
This is an implementation task.

Choose the cheapest evidence path first:
- If the owning area is unknown, use CodeGraph or narrow search/read to find exact files.
- Use TokenOpt only if broad planning is needed before finding ownership.
- Do not use TokenOpt first and then repeat the same evidence acquisition with shell/CodeGraph.

Task:
Implement this PBI:
<paste PBI>

Requirements:
- Implement the smallest safe code change.
- Add unit tests for all new behavior.
- Target 100% coverage for new code paths introduced by this PBI.
- Follow existing test style.
- Run only the narrowest relevant tests.
- Report changed files and validation result.

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 8. Write Unit Tests For A Class Or Module

```text
This is a specific test-writing task.

Do not call TokenOpt first if the target class/module is known.
Use CodeGraph or narrow search/read to find the class, related tests, and existing test style.
Avoid broad scans and full-suite tests.

Task:
Write unit tests for <class/module/function>.
Cover core behavior, edge cases, and error handling.
Follow existing test style.
Run only the relevant test file or narrow test command.

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 9. Unit Test Planning Only

```text
Choose the cheapest evidence path first.

If this is only test planning, use TokenOpt MCP as a cost gate.
If exact class/test files are needed, use CodeGraph or narrow search/read.

Task:
Plan unit tests for <class/module>.
Identify behaviors, edge cases, existing test style, and narrow validation command.
Do not edit files yet.
```

### 10. Code Review

```text
Review the current diff.

Do not use TokenOpt first unless the diff lacks basic context.
Use CodeGraph only if call graph or dependency impact is unclear.
Focus on correctness, regressions, missing tests, security, and performance risks.

Return:
1. Findings first, ordered by severity
2. File/line evidence
3. Missing tests
4. Open questions
5. Short summary only after findings
```

### 11. Field / Schema Impact

```text
Choose the cheapest evidence path first.

This is an exact impact analysis task. Use CodeGraph if available for symbol/dependency impact.
Use TokenOpt only if broad business/context summary is needed first.

Task:
Analyze the impact of changing field/schema <field name>.
Find producers, consumers, validation, persistence, API contracts, tests, and migration risks.

Return:
- Impacted business flow
- Impacted files/symbols
- Risk areas
- Test plan
- Migration/compatibility notes
```

### 12. Startup / Bootstrap Flow

```text
This is an exact startup flow trace.

Do not call TokenOpt first unless a broad repo overview is needed.
Use CodeGraph or narrow search/read to identify entrypoints and initialization order.

Task:
Trace application startup/bootstrap flow.
Identify entrypoint, config loading, dependency initialization, background jobs, external connections, and failure points.
Cite concrete files and symbols.
```

### 13. Build / Daily Handoff

This is a good TokenOpt-first task.

```text
Choose the cheapest evidence path first.

This is a broad repo handoff task, so use TokenOpt MCP as a cost gate if available.
Call tokenopt_compile_evidence once.
If answerable=true, answer from the packet with no extra exploration.

Task:
Prepare a daily handoff for this repo: build tool, package manager, important scripts, test/lint commands, risky areas, and recommended narrow validation.
```

### 14. Benchmark TokenOpt

Use this only for benchmark runs.

```text
Use TokenOpt as the first acquisition path for this benchmark.

Call tokenopt_compile_evidence with the inferred task_type.
If answerable=true, answer from the packet and do not call more tools.
If answerable=false, use only allowed TokenOpt followups.

Task:
<actual task>

Report:
- input tokens
- output tokens
- tool calls
- MCP calls
- shell calls
- fallback after answerable
- answer quality
```

### 15. TokenOpt + CodeGraph Router

Use this when both MCP servers are available.

```text
Choose the cheapest evidence path first.

Use TokenOpt MCP only as a cost gate for broad repo/business/planning tasks.
Use CodeGraph only when exact code ownership, call graph, dependency graph, or symbol flow is needed.
Do not call TokenOpt and CodeGraph both unless the first path cannot answer.
Do not repeat the same evidence acquisition with shell/search after MCP.

Start the answer with:
Acquisition path:
Reason:
Fallback used:

Task:
<your task>
```

## Anti-Patterns

Do not paste benchmark/report instructions into a normal prompt:

```text
Project instruction injected by TokenOpt setup:
The user may ask naturally and does not need to name MCP tools.
When TokenOpt MCP tools are available...
```

Do not use this for exact flow/class work:

```text
Always use TokenOpt first.
Trace <specific class or flow> line by line.
```

Do not ask for all acquisition paths:

```text
Use TokenOpt, CodeGraph, shell search, and read all relevant files.
```

Those prompts commonly cause input tokens to increase.

## Troubleshooting

### Copilot Does Not Call TokenOpt

Check:

```text
/mcp show tokenopt
/agent
```

Expected setup files:

```text
.github/copilot-instructions.md
.github/instructions/tokenopt.instructions.md
.github/agents/tokenopt-cost-gate.agent.md
AGENTS.md
```

If Copilot still does not call MCP for broad tasks, mention the agent:

```text
Use the tokenopt-cost-gate agent if available.
Task: <actual broad task>
```

### Token Count Increased

Likely causes:

- TokenOpt was called and then the agent repeated the same work with shell/search.
- TokenOpt was called and then CodeGraph was called for the same evidence.
- The prompt pasted benchmark fields such as `injectedInstruction` or `actualPromptSentToCodex`.
- The task was exact code-level work where TokenOpt-first was not the cheapest path.

Fix:

```text
Choose the cheapest evidence path first.
Never do TokenOpt first and then repeat the same exploration with shell, search, or CodeGraph.
Start your answer with Acquisition path, Reason, and Fallback used.
```

### Need Stronger Enforcement

Instructions and Copilot custom agents are soft routing signals. For strict TokenOpt acquisition, run a mode where the host shell tool is disabled and TokenOpt MCP is the only acquisition path. Use strict mode for benchmarks, not for every day-to-day exact-code task.

## Sources

- GitHub Copilot repository instructions: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions>
- GitHub Copilot custom agents: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents>
- GitHub Copilot custom agent configuration: <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
- GitHub Copilot MCP setup: <https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
