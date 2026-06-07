# TokenOpt Separation And CodeGraph MCP Plan

This document converts the TokenOpt research into an implementation boundary for
CodeGraph. The main decision is that CodeGraph should stay focused on indexed
repository intelligence, while TokenOpt should become a standalone context-budget
middleware that can run across all repositories and agent clients.

## Decision Matrix

CodeGraph owns semantic repo context. It should not own every agent lifecycle
control point, shell policy, instruction file, or compaction workflow.

| Idea | Apply to CodeGraph MCP | Split out | Reason | Priority |
| --- | --- | --- | --- | --- |
| Repo Context Router MCP | Yes | No | CodeGraph already indexes files, symbols, calls, dependencies, endpoints, tests, and source slices. | P0 |
| Budgeted pack tools | Yes | No | `get_research_pack`, `get_flow_pack`, `get_change_pack`, `get_context_packet`, and `review_patch` should keep returning bounded evidence. | P0 |
| PR/diff context budgeter | Yes | No | `review_patch` belongs next to graph impact, changed hunks, likely tests, and evidence handles. | P0 |
| MCP tool schema/profile trimming | Yes | No | This reduces always-on MCP tool overhead without changing CodeGraph ownership. | P0 |
| Repo atlas/brief | Yes | No | `generate_repo_atlas` is indexed repo intelligence and should remain in CodeGraph. | P1 |
| Daemon query telemetry | Yes | Partial | CodeGraph should log query duration, response size, and MCP budget metrics; cross-repo waste reports belong in TokenOpt. | P1 |
| PreToolUse budget governor | No | Yes | It must intercept shell, file reads, MCP calls, and editor tools in any repository, not just indexed CodeGraph workspaces. | P0 |
| Tool output compressor | No | Yes | Test/build/log compression should work for repos without Postgres or a CodeGraph snapshot. | P0 |
| Instruction Diet CI | No | Yes | Auditing `AGENTS.md` and Copilot instruction files is a repository hygiene tool, not graph query behavior. | P1 |
| Memory/compaction distiller | No | Yes | It depends on Codex/Copilot session lifecycle and transcript state, not source graph data. | P1 |
| Prompt cache canonicalizer | No | Yes | It only applies when we own the OpenAI API prompt path or build an agent proxy. | P2 |
| Cross-repo dashboard | No | Yes | It aggregates sessions, hooks, logs, and repositories beyond one CodeGraph daemon. | P2 |

## Split Out As Standalone TokenOpt

TokenOpt should be a separate package or repo eventually. It can start from this
design, but it must not require Postgres, CodeGraph indexing, or a completed
snapshot.

Recommended package shape:

| Package | Responsibility |
| --- | --- |
| `policy-core` | Pure TypeScript rule engine for allow, deny, rewrite, and report decisions. It should accept normalized tool calls and return deterministic policy results. |
| `codex-adapter` | Codex hook stdin/stdout adapter for `UserPromptSubmit`, `PreToolUse`, and `PreCompact`. It translates Codex hook payloads into `policy-core` inputs and emits Codex-compatible JSON. |
| `copilot-adapter` | Later adapter for `.github/hooks/*.json` and personal Copilot hooks, especially `postToolUse` where Copilot can replace tool output. |
| `log-compressor` | Deterministic parsers for `vitest`, `jest`, `pytest`, `tsc`, `eslint`, `go test`, `cargo`, `maven`, and `docker build`. It should preserve exit status, failing tests, first assertions, useful stack roots, and rerun commands. |
| `instruction-audit` | Scans `AGENTS.md`, `.github/copilot-instructions.md`, and `.github/instructions/*.instructions.md` for size, duplication, conflicts, missing commands, and path split opportunities. |
| `observability` | Writes `tokenopt.jsonl`, computes top waste, reports denied/rewritten calls, and aggregates estimated token savings by layer. |

Recommended CLI surface:

```text
tokenopt install codex
tokenopt hook pre-tool-use
tokenopt hook user-prompt-submit
tokenopt hook pre-compact
tokenopt exec -- <command...>
tokenopt instructions audit
tokenopt report
```

Core design rules:

- TokenOpt must work without CodeGraph.
- TokenOpt may use CodeGraph as an optional repo-context provider when a matching
  MCP server or daemon is configured.
- TokenOpt policy decisions must be deterministic and explainable.
- TokenOpt should store raw command artifacts outside the model context when it
  compresses output, so humans can still inspect the full failure.
- TokenOpt should not rewrite source files; it governs context flow and tool
  outputs.

Initial policies:

| Policy | Default action | Rationale |
| --- | --- | --- |
| Large full-file read | Deny or rewrite to bounded slice | Prevent low-signal context dumps. |
| Unbounded repo search | Deny with targeted search hint | Avoid repeated full-repo exploration. |
| Lockfile/generated read | Deny unless dependency/build task | Lockfiles and generated artifacts are usually high-token and low-signal. |
| Full test suite first | Rewrite through `tokenopt exec` or warn | Focus on targeted tests before expensive suites. |
| Verbose test/build output | Compress | Preserve actionable failures while removing repeated noise. |

## Keep / Update In CodeGraph MCP

CodeGraph should continue to be the indexed repo intelligence layer. The MCP
server should expose compact, evidence-backed tools that agents use before raw
shell search or broad file reads.

Keep improving:

- `get_research_pack`
- `get_flow_pack`
- `get_change_pack`
- `review_patch`
- `get_context_packet`
- `generate_repo_atlas`

Planned CodeGraph updates:

- Keep compact MCP tool descriptions as the default behavior, and document how to
  disable them with `CODEGRAPH_MCP_COMPACT_TOOL_DESCRIPTIONS=0` when verbose
  descriptions are useful for debugging.
- Add MCP tool profiles as predefined allowlists:
  - `minimal`: pack tools, source slices, and index stats.
  - `research`: research, flow, context, endpoint, dependency, and atlas tools.
  - `change`: implementation planning, targeted search, patch impact, tests, and slices.
  - `review`: review packet, patch impact, impacted references, tests, and slices.
- Normalize pack budget metadata:
  - `requestedTokenBudget`
  - `estimatedResponseTokens`
  - `estimatedFullResponseTokens`
  - `estimatedTokensSaved`
  - `capExceeded`
  - `evidenceHandleCount`
- Tune `review_patch` so agents get exact follow-up slice hints, impacted flow,
  likely tests, and validation gaps without broad shell fallback.
- Keep daemon telemetry focused on CodeGraph query cost, MCP response size,
  budget metrics, and evidence quality signals.

## Implementation Boundary

| Component | Owns | Does not own |
| --- | --- | --- |
| CodeGraph | Indexed repo facts, semantic search, graph packets, source slices, likely tests, review impact, atlas, MCP response telemetry. | Shell policy, editor hook installation, cross-repo instruction audits, transcript memory, generic test log compression. |
| TokenOpt | Cross-repo hook adapters, policy rules, output compression, instruction audit, compaction/memory helpers, multi-repo waste reports. | Building semantic repo indexes or duplicating CodeGraph query logic. |
| Shared integration | TokenOpt can route repo-context requests to CodeGraph when available and can link reports to CodeGraph daemon telemetry. | Either project becoming a hard runtime dependency of the other. |

This boundary keeps CodeGraph useful as a standalone MCP server and keeps
TokenOpt reusable across every repository.

## CodeGraph MCP Update Plan

1. Align compact description behavior and documentation.
   - Keep the current compact-by-default behavior.
   - Document `CODEGRAPH_MCP_COMPACT_TOOL_DESCRIPTIONS=0` as the escape hatch.

2. Add MCP profile support.
   - Add `--mcp-profile <minimal|research|change|review|full>`.
   - Add `CODEGRAPH_MCP_PROFILE`.
   - Let explicit `--mcp-tools` remain the strongest allowlist when provided.

3. Normalize budget metadata.
   - Extend the shared budget report helper.
   - Preserve existing fields for compatibility.
   - Add requested fields as aliases where needed.

4. Improve review packet routing.
   - Include a first exact batch `get_file_slice` hint when review targets or
     line focus exist.
   - Add review guidance that says to inspect listed slices before any broad
     repository search.

5. Update docs and tests.
   - Cover MCP profiles, compact descriptions, and normalized budget fields.
   - Add focused tests for tool profile filtering and budget metadata.

## Test Plan

- Unit tests for compact description default and profile filtering.
- Query tests for normalized budget metadata in `get_context_packet`,
  `get_change_pack`, `get_flow_pack`, and `review_patch`.
- Review regression test that checks `review_patch` returns exact follow-up slice
  hints and bounded compact/balanced metadata.
- Run `npm run lint`.
- Run focused Vitest coverage for MCP/query behavior.

## Assumptions

- This document is documentation-first; it does not implement the standalone
  TokenOpt package yet.
- TokenOpt should become a separate package or repo once the CodeGraph boundary
  is stable.
- The current dirty worktree is intentional and should not be reverted while
  implementing this plan.
