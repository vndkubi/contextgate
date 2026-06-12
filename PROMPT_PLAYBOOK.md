# ContextGate Prompt Playbook

This guide shows how to prompt agents so ContextGate, exposed by the current TokenOpt MCP tools, and native narrow search/read are used only when they reduce context cost.

## Core Rule

Do not force TokenOpt first for every task.

Use the cheapest evidence path:

```text
Broad repo/business/planning task -> ContextGate cost gate.
Exact code/call flow task -> native narrow search/read.
Known file/class task -> native narrow search/read.
Review current diff -> diff/review context first.
Never repeat the same evidence acquisition with ContextGate + shell/search/read.
```

## Setup Pattern

ContextGate needs two things to route normal prompts reliably:

1. The `tokenopt` MCP server must be available to the agent.
2. Repo or agent instructions must explain when to use ContextGate as a cost gate.

For Copilot-style setup in a target repo:

```powershell
cd <target-repo>
node <tokenopt-repo>\dist\cli.js setup copilot --scope both
node <tokenopt-repo>\dist\cli.js doctor copilot
```

For a strict Codex MCP-only benchmark or session, disable the host shell tool and expose TokenOpt:

```toml
[features]
shell_tool = false

[mcp_servers.tokenopt]
command = "node"
args = ["<tokenopt-repo>/dist/cli.js", "mcp", "--mode", "lite"]
required = true
default_tools_approval_mode = "approve"
```

Lite mode exposes:

```text
tokenopt_compile_evidence
tokenopt_search
tokenopt_read_file
```

The normal user prompt should stay natural. The setup instructions, not the user prompt, should contain the tool contract. For Copilot UI, `tokenopt setup copilot` also installs native prompt files under `.github/prompts`, so repeated tasks can be launched with slash prompts instead of copying playbook text.

Good normal prompt after setup:

```text
Investigate the primary learning/recall flow and return files, symbols, risks, and evidence.
```

Good Copilot slash prompts after setup:

```text
/business-deep-dive checkout payments
/flow-trace checkout API flow
/trace-bug failing checkout authorization test
/write-unittest OrderService payment authorization
/security-audit <diff or PR scope>
/review-code <diff>
/pbi-plan <requirement text or ticket URL>
/refactor-scope OrderService validation extraction
/performance-analysis checkout latency
/build-handoff
```

Prompt pack coverage against the 37-prompt benchmark:

| Benchmark prompts | Reusable Copilot prompt | Notes |
| --- | --- | --- |
| `U1`, `U7`, `J4` | `/flow-trace` | Exact entrypoint/endpoint/class means native narrow search/read first; unknown broad flow may use TokenOpt once. |
| `U2`, `U6` | `/pbi-plan` | Requires concrete PBI/requirement/ticket/acceptance criteria; otherwise ask and do not inspect repo. |
| `U3`, `S8` | `/write-unittest` | Requires concrete class/module/file/behavior; full mode may use coding coverage once. |
| `U4` | `/requirement-analysis` | Requires requirement text or URL; missing artifact is `needs_input_bypass`. |
| `U5` | `/repo-benchmark-analysis` | Broad repo benchmark/readiness task; TokenOpt-first is appropriate. |
| `U8`, `S4`, `J6`, `J10`, `J11` | `/trace-bug` | Use `tokenopt_failure_packet` for long logs; otherwise native narrow search/read from failing test, stack frame, or repro. |
| `U9`, `J14` | `/performance-analysis` | Measurement-first; exact endpoint/query/module uses narrow reads. |
| `U10` | `/security-audit` | Requires concrete diff/scope/risky surface and security coverage dimensions. |
| `U11` | `/dependency-analysis` | Use broad build facts only when needed; avoid lockfiles unless the dependency question requires them. |
| `U12` | `/onboarding-guide` | Broad repo setup/map/verification guide; TokenOpt-first is appropriate. |
| `S1` | `/spec-autorun` | SpecKit phase/checkpoint planning with evidence reuse. |
| `S2`, `S6`, `J5` | `/implement-feature` | Use for feature implementation planning; known target bypasses broad ContextGate. |
| `S3`, `J2`, `J9`, `J12`, `J13`, `J15` | `/review-code` | Diff-first review; no diff/scope means ask instead of exploring. Use `/security-audit` only for security-focused review. |
| `S5`, `J3`, `J7`, `J8` | `/refactor-scope` | Scope definitions/usages/config/tests/contracts before edits. |
| `S7` | `/spec-feature-plan` | Feature specification and acceptance criteria from repo/domain evidence. |
| `S9` | `/promote-review-memory` | Requires completed-task summary/diff/transcript/review outcome. |
| `S10` | `/context-budget` | Context budget and compaction checkpoint planning. |

Additional reusable prompts outside the 37-prompt suite: `/business-deep-dive`, `/build-handoff`, and `/field-impact`.

Good explicit smoke-test prompt:

```text
Use ContextGate as a cost gate.
Investigate the primary learning/recall flow.
If the packet is answerable, answer from it and do not call shell/search again.
```

Avoid pasting setup or benchmark artifacts into normal prompts. Do not paste fields such as `injectedInstruction`, `actualPromptSentToCodex`, or `Project instruction injected by TokenOpt setup:` into chat.

## Production Prompt vs Benchmark Harness

Use the playbook prompts for day-to-day work. Use benchmark prompts only for measurement.

| Prompt/source | Reuse in normal work? | Purpose | Notes |
| --- | --- | --- | --- |
| Native `.github/prompts/*.prompt.md` files | Yes | UI-native repeated tasks | Prefer slash prompts for common tasks so users do not copy this playbook. |
| Standard Cost Router Prefix in this playbook | Fallback | Production prompt policy | Use only when repo instructions or prompt files are unavailable. |
| Installed repo/agent instructions | Yes | Persistent routing setup | Put tool names and routing rules here, not in every user prompt. |
| Explicit smoke-test prompt | Sometimes | Verify the agent sees TokenOpt MCP | Use only when checking setup or debugging routing. |
| Benchmark suite prompt | No | A/B measurement and deterministic scoring | It includes constraints, repo paths, output contracts, and shell/MCP controls that can increase tokens in normal use. |
| Raw benchmark report prompt fields | No | Audit trail | Do not paste `codexPrompt`, `injectedInstruction`, or `Benchmark constraints` into chat. |

When converting a benchmark task into a reusable prompt, keep only the task intent and optionally the short cost-router prefix.

Benchmark harness prompt:

```text
Investigate the primary user/business flow in this repository. Return JSON with files, symbols, terms, risks, and evidence.

Benchmark constraints:
- Preserve the requested output format exactly.
- Repository root: D:\Personal\Projects\doughnut
- TokenOpt router selected strict acquisition for this task.
- Call tokenopt_compile_evidence with cwd=...
```

Reusable production prompt:

```text
Choose the cheapest evidence path first.

Use TokenOpt MCP as a cost gate if this can replace broad exploration.
If answerable=true, answer from the packet and do not call shell/search again.

Task:
Investigate the primary user/business flow in this repository. Return files, symbols, terms, risks, and evidence.
```

## Benchmark-Backed Routing Table

This table summarizes the route behavior from the 37-prompt real Codex benchmark on the Doughnut repository. Token deltas compare `router-best` against baseline.

| Use case | Route setup | Use TokenOpt first? | Benchmark result | Practical rule |
| --- | --- | --- | --- | --- |
| Broad repo flow, onboarding, context inspection, dependency/build analysis | MCP-first strict, shell off | Yes | `broad_flow`: `-82.3%` total tokens, quality improved from `0.845` to `0.905` | Use `tokenopt_compile_evidence` once, then answer or use exact allowed followups. |
| Runtime/debug/build failure/root cause | MCP-first strict, shell off | Yes | `debug_runtime`: `-78.1%` total tokens, quality improved from `0.778` to `0.944` | Use TokenOpt first to compress failure evidence and keep followups exact. |
| Coding implementation/unit-test with concrete target | Full-mode coding coverage | Yes if full-mode tools are available | New coverage layer; benchmark pending | Use `tokenopt_compile_evidence` once, then follow only the capped coding followup if coverage is missing. |
| PBI/requirement/unit-test/review-memory prompt missing its artifact | Missing-artifact bypass | Yes, as a cheap gate | New guardrail | Return bounded JSON asking for the missing artifact. Do not scan the repo. |
| Refactor, migration, implementation planning | MCP-first strict, shell off | Usually yes | `refactor_scope`: `-74.4%` total tokens, same average quality `0.938` | Use TokenOpt for impact scope unless the owning file/class is already known. |
| Unit-test planning or unknown owning test area | MCP-first strict, shell off | Yes for planning | `exact_symbol`: `-61.4%` total tokens, quality improved from `0.750` to `1.000` | For planning, TokenOpt is useful. For writing tests against a known class, use narrow reads directly. |
| Security audit | Security coverage route | Yes, as a coverage gate | New guardrail | Require concrete scope and security dimensions before findings; otherwise ask for scope or exact followups only. |
| Review with a concrete diff or patch | Review evidence route | Yes if diff is present | Worktree PR benchmark: `-83.6%` input tokens overall, but recall still needs review-specific safeguards | Give the net diff and read follow-up context from the PR merge/head worktree. TokenOpt can compile review-shaped evidence, but the final answer must still run technical and business coverage checks. |
| Review without a concrete diff | Missing-artifact bypass | Yes, as a cheap gate | Previously expensive; now guarded | Ask for the diff, changed files, PR, or exact target. Do not use shell fallback. |
| Small repo plus exact file/symbol | Bypass | No | Router marks this as negative control | Use native narrow read/search. |
| Exact class/method/line-level flow trace | Native narrow search/read | Usually no | Hybrid double-spend risk | Use narrow search/read directly unless you need a broad context summary first. |
| Exact bug trace / tracebug with known target | Native narrow search/read | No | Hybrid double-spend risk | Start from failing test, stack frame, file, symbol, or repro path. Use `tokenopt_failure_packet` only for long failure output. |
| Simple non-repo question or tiny command | Bypass | No | Not a TokenOpt workload | Answer directly or run the tiny command. |

## Code Review Playbook

Use this shape for normal PR/code review prompts, including `/review-code`.

```text
Review this PR/diff in two phases:
1. Technical review: correctness, regressions, security, performance, reliability, compatibility, and maintainability.
2. Business/test coverage review: requirement coverage, edge cases, and ISTQB-style test design.

When TokenOpt MCP is available and a concrete review artifact exists, first call `tokenopt_compile_evidence` with `task_type=review_diff`, current `cwd`, budget around 2200, and the full user request plus the complete net unified diff in `task`.
Use the net PR diff and PR merge/head worktree for any follow-up reads/searches.
For branch-pair review, treat target/base branch and feature/head branch as the final PR scope, acquire the merge-base net diff, then call TokenOpt before writing the review.
If the user attaches or references Jira tickets or Confluence pages, use the available Jira/Confluence MCP tools to read the ticket/page and relevant attachments before business/test coverage review. Do not ask the user to paste the full ticket/page content when a connector can read it. These are requirement artifacts, not a substitute for the code diff/PR/branch pair.
If the user provides a review checklist, treat it as a required review rubric and return checklist coverage item by item.
Do not review per-commit patch output as the final PR state.
Return compact JSON with:
technical_review, business_review, istqb_checks, user_checklist, review_status, evidence_contract_pass, acquisition_mode, notes.
```

Technical review rules:

- Do not skip TokenOpt silently. If MCP is unavailable, say so in `notes` and continue with native net-diff review.
- Report only introduced, actionable defects.
- If TokenOpt evidence includes `recall_probe` facts, adjudicate each checked probe as a technical finding, coverage gap, or explicit non-issue with contrary evidence. Promote P1/P2 `technical_finding_candidate=true` probes unless contrary evidence disproves them.
- Before returning no findings, explicitly check changed invariants, effective config/policy math, parser/encoding boundaries, backwards compatibility, concurrency/async behavior, resource lifecycle, null/error paths, and call replacements.
- Do not downgrade a proven regression into a missing-test or business coverage gap.
- Security/domain words such as `security`, `auth`, `privilege`, or `permission` do not by themselves mean `/security-audit`; use security-audit only when the user explicitly asks for a security audit/review or vulnerability scan.

Business/test coverage rules:

- Keep coverage gaps separate from technical findings.
- Ground requirement coverage in Jira/Confluence evidence, including ticket/page attachments when relevant, when the user provides those artifacts. If Jira/Confluence MCP is unavailable or unreadable, say so in `notes` and mark requirement-backed coverage as missing or assumption-based.
- Apply ISTQB-style dimensions where relevant: boundary values, equivalence partitions, negative/error cases, state transitions, concurrency/async, and compatibility/backward compatibility.
- Tie every suggested test to the changed behavior and expected business rule.
- Missing tests are usually `comment`, not `request_changes`, unless the risky behavior is untested enough to make the patch unsafe.

User checklist rules:

- Preserve the user's checklist items as explicit review obligations.
- For each item, return `pass`, `fail`, `gap`, or `not_applicable` plus evidence or a short reason.
- A checklist item can raise a technical finding only when the diff introduces an actionable defect; otherwise report it as coverage/commentary.
- User checklist items add coverage, but they do not suppress higher-severity defects found outside the checklist.

Review benchmark lessons:

- Hadoop #8511: both baseline and TokenOpt found a real exceptional-path resource lifecycle issue; the review checklist should keep async/resource lifecycle explicit.
- Hadoop #8541: TokenOpt missed a stale-interval config invariant regression; review prompts must force invariant/effective-policy checks before "no findings".
- Elasticsearch #151093: Unicode/surrogate language-equivalence was a plausible miss; parser/encoding boundary checks matter for security/authorization code.

Aggregate from that benchmark:

| Setup | Tasks | Correct | Token effect | Avg MCP | Avg shell |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mcp-first-strict(shell-off)` | 28 | 23/28 | `-82.6%` total tokens | 4.1 | 0 |
| `hybrid-review-fallback(shell-on)` | 9 | 9/9 | `+47.2%` total tokens | 0 | 39 |

The main lesson is that strict MCP-first works when it replaces broad exploration. It loses when the agent pays both costs: TokenOpt or route setup plus broad shell fallback. Current router guidance treats missing-artifact review and planning prompts as ask/bounded-answer cases instead of shell fallback cases.

## What The Agent Should Report

Add this contract when you want to audit whether the agent chose the right path:

```text
Start your answer with:
Acquisition path: ContextGate MCP | native narrow search/read | tokenopt_failure_packet + narrow read | diff context | needs_input_bypass
Reason:
Fallback used: yes/no
```

If the answer says `Acquisition path: ContextGate MCP` and then performs broad shell/search/read for the same evidence, that is a failed run.

## Standard Cost Router Prefix

Use this prefix for most natural tasks:

```text
Choose the cheapest evidence path first.

If this is a broad repo/business/planning task and ContextGate MCP is available, use ContextGate as a cost gate:
- Call tokenopt_compile_evidence once.
- If answerable=true, answer from the packet and do not call shell/search/read again for the same evidence.
- If answerable=false, use only its allowed TokenOpt followups.

If this is an implementation, unit-test, fix, or debug task and TokenOpt full-mode coding tools are available:
- Call tokenopt_compile_evidence once.
- Treat answerable=true as valid only when coding coverage includes exact target symbol, signature/definition slice, dependencies/usages, test neighbor/style, build/test command, and failure context when relevant.
- If answerable=false, use only the allowed coding followups.

If this is an exact code-flow/class/method/PBI task that needs line-level proof, do not call ContextGate first. Use narrow search/read directly.

If this is an exact bug trace with a known file, class, function, line, failing test, stack frame, repro path, or exact behavior, do not call ContextGate first. Use native narrow search/read directly. Use tokenopt_failure_packet only when long failure output needs compression into exact files/lines.

Never do ContextGate first and then repeat the same exploration with shell, search, or read.

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
| Exact flow/class/method trace | Usually no | Use narrow search/read directly. |
| Exact bug trace with known target/failing test/stack frame | No | Use native narrow search/read directly; use `tokenopt_failure_packet` only for long failure output. |
| Unknown-owner implementation, unit-test, fix, or failure task | Yes in full mode | Use ContextGate coding coverage once, then only allowed coding followups. |
| Known file/module implementation | Usually no | Start from the known file/module and run narrow validation. |
| Review current diff | Usually no | Use diff context first; use narrow search/read only for unclear impact. |

## When To Bypass ContextGate

Bypass ContextGate when exact code structure is already the task:

- Owning class/function/module discovery.
- Call flow or dependency impact around a known symbol.
- API/service/domain flow with line-level proof.
- Impact analysis from a specific symbol or field.
- Implementation where the owning file/symbol is already known.

Use native narrow search/read with bounded queries for those cases. Do not run a second exploration path after ContextGate already returned `answerable=true`.

## Prompt Samples

### 1. Business Deep Dive

Use this when the user wants business understanding, glossary, and business flow.

```text
Choose the cheapest evidence path first.

This is a broad business/domain understanding task. If TokenOpt MCP is available, use tokenopt_compile_evidence once as a cost gate.
If answerable=true, answer from the packet and do not call shell/search/read again.
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
- Exact code-flow task -> narrow search/read directly.
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
Use narrow search/read only for call flow and symbol ownership.
Avoid broad repo scans.

Task:
Trace the <flow name> flow end to end.
Start from the likely entrypoint, follow service/domain/storage/external calls, cite files and symbols, and produce a Mermaid sequence diagram.

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 3b. Trace Bug / Exact Bug Investigation

Use this when the bug has a concrete failing test, stack frame, file, class, function, line, repro path, or exact behavior. This is a standard bypass workflow: do not call ContextGate first for line-level bug tracing.

```text
This is an exact bug trace.

Choose the cheapest evidence path first:
- If the prompt names a file, class, function, line, failing test, stack frame, or repro path, use native narrow search/read directly.
- Do not call ContextGate first for exact bug tracing; it usually double-spends.
- If stack trace/build/test output is long, use tokenopt_failure_packet first, then narrow read the suggested slices.
- If no concrete bug artifact is provided, ask for failing test, stack trace/error output, repro steps, expected vs actual behavior, or target symbol.

Task:
Trace this bug:
<paste bug, failure output, failing test, target file/symbol, or repro>

Return:
- Bug summary
- Evidence chain
- Suspected root cause
- Affected files/symbols
- Targeted fix location
- Targeted verification
- Missing items

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
- Exact affected classes/functions/call flow -> use native narrow search/read.
- Known files/classes -> native narrow search/read.
- Do not use ContextGate and native exploration for the same evidence unless the first path cannot answer.

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
Use narrow search/read only if exact owning modules/classes/call flow are needed.
Avoid ContextGate + shell/search/read double-spend.

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
Use narrow search/read for exact flow or symbol ownership.

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
- If the owning area is unknown and TokenOpt full-mode coding tools are available, use ContextGate coding coverage once.
- If the owning file/module is known, use narrow search/read and targeted validation directly.
- Do not accept answerable=true for coding work unless the packet covers exact target symbol, definition/signature, dependencies/usages, test neighbor/style, and build/test command.
- Do not use ContextGate first and then repeat the same evidence acquisition with shell/search/read.

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
Use narrow search/read to find the class, related tests, and existing test style.
Avoid broad scans and full-suite tests.

If the target class/module is unknown and TokenOpt full-mode coding tools are available, use ContextGate coding coverage once and follow only its allowed coding followups.

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
If exact class/test files are needed, use narrow search/read.

Task:
Plan unit tests for <class/module>.
Identify behaviors, edge cases, existing test style, and narrow validation command.
Do not edit files yet.
```

### 10. Code Review

```text
Review the current diff.

Do not use TokenOpt first unless the diff lacks basic context.
Use narrow search/read only if call flow or dependency impact is unclear.
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

This is an exact impact analysis task. Start with narrow search/read around the field/schema for symbol/dependency impact.
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
Use narrow search/read to identify entrypoints and initialization order.

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

### 15. ContextGate-Only Router

Use this when ContextGate MCP is available and you want one optimized acquisition route.

```text
Choose the cheapest evidence path first.

Use ContextGate MCP only as a cost gate for broad repo/business/planning tasks.
Use native narrow search/read directly when exact code ownership, call flow, dependency impact, or symbol flow is needed.
Do not call ContextGate and then repeat the same evidence acquisition with shell/search/read.
Do not repeat the same evidence acquisition after MCP.

Start the answer with:
Acquisition path:
Reason:
Fallback used:

Task:
<your task>
```

### 16. Spec Kit Implementation Planning

Use this for `github/spec-kit` or a project initialized by Spec Kit when you want an implementation plan before editing files. This is a good TokenOpt-first workload when the owning integration, command, template, or test area is not already known.

```text
Choose the cheapest evidence path first.

Use TokenOpt MCP as a cost gate if this can replace broad exploration.
If answerable=true, answer from the packet and do not call shell/search again.
If missing exists, use only exact TokenOpt followups.

Task:
Use the Spec Kit implementation workflow to plan this change:
<describe the desired Spec Kit change>

Return valid compact JSON only with:
- files
- symbols
- implementation_steps
- tests
- risks
- evidence
```

Example:

```text
Choose the cheapest evidence path first.

Use TokenOpt MCP as a cost gate if this can replace broad exploration.
If answerable=true, answer from the packet and do not call shell/search again.
If missing exists, use only exact TokenOpt followups.

Task:
Use the Spec Kit implementation workflow to plan a small code change:
add validation so integration keys cannot contain whitespace before integrations are registered or used by the Specify CLI.

Return valid compact JSON only with files, symbols, implementation_steps, tests, risks, and evidence.
```

### 17. Spec Kit Actual Implementation

Use this when the agent should edit files. Keep TokenOpt as a planning gate only; after the owner files are known, switch to narrow file reads and targeted tests.

```text
Choose the cheapest evidence path first.

Use TokenOpt MCP once only if it can identify the owning Spec Kit integration, command, template, tests, or workflow cheaper than broad shell exploration.
If TokenOpt returns answerable=true, use the packet as the implementation map and do not repeat exploration with broad shell/search.
After ownership is known, edit only the narrow files needed.

Task:
Implement this Spec Kit change:
<describe the change>

Requirements:
- Keep the change minimal and compatible with existing Spec Kit workflows.
- Add or update targeted pytest coverage.
- Run the narrowest relevant pytest command.
- Report changed files, validation command, and remaining risks.

Start with:
Acquisition path:
Reason:
Fallback used:
```

### 18. Spec Kit A/B Benchmark Prompt

Use this only when measuring cost with `tokenopt benchmark suite`, not for normal development. The benchmark prompt should be stricter than a production prompt so quality can be scored deterministically.

```text
Use the Spec Kit implementation workflow to plan a small code change:
<describe the desired change>.

Return valid compact JSON only with files, symbols, implementation_steps, tests, risks, and evidence.
```

Recommended suite fields:

```json
{
  "class": "refactor_scope",
  "qualityRubric": [
    "identifies owning command or integration path",
    "identifies relevant metadata or registry symbol",
    "has implementation steps",
    "has targeted tests",
    "states compatibility risks"
  ],
  "maxBudget": {
    "mcpCallsCompiled": 4,
    "targetedShellCalls": 0,
    "shellCallsAfterAnswerable": 0,
    "packetTokens": 1600
  }
}
```

In a one-task Spec Kit benchmark against `github/spec-kit`, a planning prompt for integration-key whitespace validation measured `router-best` at `297,166` total tokens versus `927,192` baseline tokens, a `67.9%` reduction. That result applies to broad implementation planning, not necessarily to every exact code-edit task.

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
Use ContextGate first, then shell search, then read all relevant files.
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
- The prompt pasted benchmark fields such as `injectedInstruction` or `actualPromptSentToCodex`.
- The task was exact code-level work where TokenOpt-first was not the cheapest path.

Fix:

```text
Choose the cheapest evidence path first.
Never do ContextGate first and then repeat the same exploration with shell, search, or read.
Start your answer with Acquisition path, Reason, and Fallback used.
```

### Need Stronger Enforcement

Instructions and Copilot custom agents are soft routing signals. For strict TokenOpt acquisition, run a mode where the host shell tool is disabled and TokenOpt MCP is the only acquisition path. Use strict mode for benchmarks, not for every day-to-day exact-code task.

## Sources

- GitHub Copilot repository instructions: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions>
- GitHub Copilot custom agents: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents>
- GitHub Copilot custom agent configuration: <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
- GitHub Copilot MCP setup: <https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
