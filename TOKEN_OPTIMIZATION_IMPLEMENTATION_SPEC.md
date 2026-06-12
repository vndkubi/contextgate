# Token Optimization Implementation Spec

This spec turns the June 2026 ContextGate token optimization research into an
implementation plan for the current TokenOpt repository.

The goal is not to implement every idea from the report. The current codebase
already has routing, compact MCP output, task-shaped full-mode tools, coverage
certificates, Java evidence helpers, and hard/shadow answerability gates. This
spec focuses on the remaining gaps that are local, measurable, and low-risk.

## Audience

- Maintainers implementing the next TokenOpt optimization pass.
- Agents making scoped code changes in this repository.
- Reviewers checking whether an implementation preserves quality while reducing
  model-visible context cost.

## Source Material

- `C:\Users\SonCao\Downloads\contextgate_token_optimization_report\contextgate_token_optimization_report.md`
- The second downloaded copy of `contextgate_token_optimization_report.md`
  under the `Kimi_Agent_Token ...` downloads folder referenced in this thread.
- `research/contextgate-complete-research-synthesis.md`
- Current repo files under `src/`, `test/`, `README.md`, and
  `PROMPT_PLAYBOOK.md`.

The two downloaded report files have the same section structure. The newer
version only replaces three citation placeholders with links, so it is treated
as the canonical external report.

## Current Repo Baseline

TokenOpt already has several mechanisms that the report describes as future
work:

| Area | Current implementation |
| --- | --- |
| Task router | Rule-based router with negative controls in `src/router.ts`. |
| MCP profiles | `lite` and `full` modes in `src/mcp.ts`. |
| Compact evidence output | `detail=compact` default; full packet stored in `state_path`. |
| Answerability gate | `hard`, `shadow`, and `off` modes in `src/hard-gate.ts`. |
| Coverage certificate | `CoverageCertificate` and packet coverage in `src/types.ts` and `src/mcp.ts`. |
| Java evidence helpers | Java diff, Jakarta annotation filter, Spring context assembler. |
| Compressors | Build log, Java trace, JSON result, error summary, and review finding compressors. |
| Benchmark proof | Daily, suite, and Codex benchmark runners with quality scoring. |

The remaining confirmed gaps are:

- Token estimation is duplicated and uses `chars / 4` in many files.
- Evidence state has TTL but no repository fingerprint invalidation.
- Coding symbol discovery scans source files repeatedly instead of using a
  persisted index.
- File read and command output caps are fixed, not adaptive to task class,
  current budget, or output kind.
- Router accuracy should be measured before adding a heavier semantic model.

## Goals

1. Centralize token estimation behind one API.
2. Add repository fingerprint invalidation to evidence state and packet caching.
3. Add a persistent, lazy symbol index for coding coverage flows.
4. Make compression and bounded read budgets adaptive while preserving
   deterministic behavior.
5. Extend benchmarks to prove token reductions at equal or acceptable quality.

## Non-Goals

- Do not add an embedding or ML semantic classifier in the first pass.
- Do not add model-based semantic summarization for logs.
- Do not implement host-level conversation pruning or compaction in this pass.
- Do not rewrite the router architecture unless benchmark data proves a
  specific misroute class.
- Do not add new runtime services, databases, or background daemons.

## Success Metrics

| Metric | Target | Measurement |
| --- | --- | --- |
| Token estimator drift | Lower than current `chars / 4` heuristic on mixed text/code fixtures | Unit fixtures with expected ranges |
| Repeated evidence compile time | 40-70% lower on cached coding queries | Focused benchmark around `tokenopt_compile_evidence` |
| Stale packet reuse | 0 packets reused after repo fingerprint change | Unit/integration tests |
| Model-visible compressed output | 15-30% lower for large JSON/build/error outputs | Compressor fixture tests |
| Quality regression | No material drop below current benchmark floor | `benchmark suite` and existing tests |
| Fallback after answerable | No regression from current gate behavior | Existing benchmark metadata |

These targets are implementation gates, not marketing claims. If a benchmark
cannot isolate a target, add the instrumentation first.

## Phase 0: Measurement Guardrails

Phase 0 prevents later optimization work from becoming unverifiable.

### Implementation

- Add benchmark metadata fields where missing:
  - `estimator_version`
  - `repo_fingerprint`
  - `evidence_cache_hit`
  - `symbol_index_hit`
  - `compression_budget_chars`
  - `compression_budget_reason`
- Keep existing benchmark mode names stable.
- Prefer extending current runners over adding a new benchmark command.

### Acceptance Criteria

- Existing benchmark JSON remains backward compatible.
- New fields are optional and do not break old reports.
- `npm test` passes.

## Phase 1: Central Token Estimator

### Problem

Token estimation currently uses duplicated `Math.ceil(length / 4)` logic across
the codebase. That creates inconsistent savings estimates and makes budget
decisions harder to tune.

Known call sites include:

- `src/log-compressor.ts`
- `src/mcp.ts`
- `src/shadow-gate.ts`
- `src/benchmark.ts`
- `src/compressors/*`
- `src/assemblers/spring-context-assembler.ts`
- `src/filters/jakarta-annotation-filter.ts`
- `src/processors/java-diff-processor.ts`

### Design

Add `src/token-estimator.ts`.

```ts
export type TokenTextKind =
  | "generic"
  | "code"
  | "typescript"
  | "javascript"
  | "java"
  | "python"
  | "json"
  | "yaml"
  | "markdown"
  | "english"
  | "vietnamese";

export interface TokenEstimateOptions {
  kind?: TokenTextKind;
  modelFamily?: "openai" | "anthropic" | "google" | "unknown";
  minTokens?: number;
}

export interface TokenEstimate {
  tokens: number;
  chars: number;
  ratio: number;
  estimator: "ratio-v1";
  kind: TokenTextKind;
}

export function estimateTokens(
  value: string | number,
  options?: TokenEstimateOptions
): number;

export function estimateTokenDetails(
  value: string | number,
  options?: TokenEstimateOptions
): TokenEstimate;

export function estimateTokensSaved(
  originalChars: number,
  compressedChars: number,
  options?: TokenEstimateOptions
): number;
```

Initial ratios should stay dependency-free:

| Kind | Chars/token |
| --- | ---: |
| generic | 4.0 |
| code | 3.8 |
| typescript/javascript | 3.7 |
| java | 4.2 |
| python | 4.0 |
| json | 5.2 |
| yaml | 4.5 |
| markdown | 3.6 |
| english | 4.0 |
| vietnamese | 1.8 |

Do not add `tiktoken` in this phase. If precise tokenizers are needed later,
add them behind this API without changing callers.

### File Changes

| File | Change |
| --- | --- |
| `src/token-estimator.ts` | New centralized estimator. |
| `src/log-compressor.ts` | Import estimator; remove local `estimateTokens` or re-export wrapper for compatibility. |
| `src/mcp.ts` | Replace local estimator. |
| `src/shadow-gate.ts` | Replace local estimator and keep fixed MCP overhead as a named constant. |
| `src/benchmark.ts` | Replace local estimator. |
| `src/compressors/*` | Use `estimateTokensSaved`. |
| `src/assemblers/*`, `src/filters/*`, `src/processors/*` | Use `estimateTokensSaved`. |
| `test/*` | Add estimator tests and update expectations where estimates shift. |

### Acceptance Criteria

- `rg "Math\\.ceil\\(.*\\/ 4|length \\/ 4|chars \\/ 4" src` finds no direct
  production estimator logic except inside `src/token-estimator.ts`.
- Existing public behavior remains compatible where exact token values are not
  part of the contract.
- Tests cover JSON, Java code, TypeScript code, Markdown, and Vietnamese text.

## Phase 2: Evidence Cache And Repo Fingerprint

### Problem

`evidence-task-state.json` stores the packet and timestamp. It expires by time,
but it does not know whether the repository changed. A packet can remain within
TTL while source files, git HEAD, or staged changes changed underneath it.

### Design

Add a small repository fingerprint helper. It should be deterministic and cheap.

```ts
export interface RepoFingerprint {
  strategy: "git-head-and-status-v1" | "file-mtime-v1";
  repoRoot: string;
  head?: string;
  statusHash?: string;
  fileHash?: string;
  createdAt: string;
}

export function getRepoFingerprint(repoRoot: string): RepoFingerprint;
export function sameRepoFingerprint(a?: RepoFingerprint, b?: RepoFingerprint): boolean;
```

Strategy:

1. If inside a git repo, use:
   - `git rev-parse HEAD`
   - a bounded hash of `git status --porcelain=v1`
   - include staged/unstaged state in `statusHash`
2. If git is unavailable, fall back to a bounded file mtime/name hash using the
   same skip rules as repo inventory.

Extend `EvidenceTaskState`:

```ts
export interface EvidenceTaskState {
  packet: EvidencePacket;
  stored_at: string;
  repo_fingerprint?: RepoFingerprint;
}
```

Read path:

- `readActiveEvidenceTaskState` must reject state when the stored fingerprint
  differs from the current fingerprint.
- If old state lacks `repo_fingerprint`, treat it as valid only until TTL
  expires, but do not write new state without a fingerprint.

### Evidence Packet Cache

Add `src/evidence-cache.ts` for repeated compile requests.

```ts
export interface EvidenceCacheKey {
  taskType: string;
  normalizedTaskHash: string;
  budgetTokens?: number;
  repoFingerprintHash: string;
  mcpMode: "lite" | "full";
  detail: "compact" | "full";
}

export interface EvidenceCacheEntry {
  key: EvidenceCacheKey;
  packet: EvidencePacket;
  createdAt: string;
  expiresAt: string;
  estimatorVersion: string;
}
```

Cache only packets that are deterministic and safe to reuse. Do not cache:

- Missing-artifact prompts whose output depends on user wording details.
- Packets with explicit transient command output.
- Full debug packets built from pasted failure output unless the normalized
  failure text hash is part of the key.

### File Changes

| File | Change |
| --- | --- |
| `src/repo-fingerprint.ts` | New fingerprint helper. |
| `src/evidence-cache.ts` | New cache helper. |
| `src/evidence-state.ts` | Store and validate fingerprint. |
| `src/types.ts` | Add types. |
| `src/mcp.ts` | Look up cache before compile; write cache after deterministic compile. |
| `src/observability.ts` | Include cache metadata in events where useful. |
| `test/*` | Add stale-state and cache-hit tests. |

### Acceptance Criteria

- Packet state is rejected after source changes or staged changes in a git repo.
- Cache hit returns equivalent compact output and structured summary.
- Cache miss after fingerprint change recompiles.
- Cache never skips policy checks for read/search/run followups.

## Phase 3: Persistent Lazy Symbol Index

### Problem

Coding coverage calls `findCodingSymbols`, `buildSymbolPacket`, and
`findTestNeighbors`. These paths repeatedly call `collectCodingFiles`, read
source files, and re-extract regex-lite symbols.

### Design

Add a persisted symbol index stored under the existing repo cache directory.

```ts
export interface SymbolIndexSnapshot {
  version: 1;
  repoFingerprint: RepoFingerprint;
  createdAt: string;
  files: SymbolIndexedFile[];
  symbols: CodingSymbol[];
}

export interface SymbolIndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  language: CodingSymbol["language"];
  symbolCount: number;
}

export interface LoadSymbolIndexOptions {
  maxFiles?: number;
  forceRebuild?: boolean;
}

export function loadOrBuildSymbolIndex(
  repoRoot: string,
  options?: LoadSymbolIndexOptions
): SymbolIndexSnapshot;
```

The index should remain lazy:

- Build on first symbol query for a repo.
- Reuse while fingerprint matches.
- Rebuild when fingerprint changes.
- Keep the existing direct functions as compatibility wrappers.

### File Changes

| File | Change |
| --- | --- |
| `src/coding/symbol-index-persistent.ts` | New persisted index loader. |
| `src/coding/symbol-index.ts` | Route searches through loaded index where safe. |
| `src/coding/test-neighbors.ts` | Reuse indexed file list if available. |
| `src/coding/coverage-contract.ts` | Add metadata for `symbol_index_hit`. |
| `test/coding-layer.test.mjs` | Add cache hit/stale rebuild tests. |

### Acceptance Criteria

- First query builds an index and produces current results.
- Second equivalent query avoids a full filesystem scan.
- A changed source file invalidates the index.
- Existing symbol packet and test neighbor tests still pass.
- The index file is stored outside the model-visible packet.

## Phase 4: Adaptive Budgets

### Problem

`maxFileReadBytes`, `maxCommandOutputChars`, and compressor limits are fixed.
This is simple but wasteful: a review summary, a JSON result, and a debug stack
trace do not need the same budget.

### Design

Add `src/budget.ts`.

```ts
export type BudgetReason =
  | "config-default"
  | "task-class"
  | "output-kind"
  | "explicit-argument"
  | "safety-margin";

export interface ContextBudgetInput {
  configuredMaxChars: number;
  taskClass?: TaskClass;
  outputKind?: CompressionResult["kind"];
  requestedMaxChars?: number;
  budgetTokens?: number;
}

export interface AdaptiveCharBudget {
  maxChars: number;
  reason: BudgetReason;
  ceilingChars: number;
  floorChars: number;
}

export function computeAdaptiveOutputBudget(input: ContextBudgetInput): AdaptiveCharBudget;
export function computeAdaptiveReadBudget(input: ContextBudgetInput): AdaptiveCharBudget;
```

Initial deterministic policy:

| Task/output | Suggested cap |
| --- | ---: |
| `review_diff` findings | 6,000 chars |
| `debug_runtime` errors/traces | 8,000 chars |
| JSON result | 6,000 chars |
| build/test log | 8,000 chars |
| generic long output | 10,000 chars |
| exact symbol read | current bounded slice behavior |

Rules:

- Never exceed explicit user/tool `max_chars` or config hard max.
- Keep a floor so tiny outputs are not over-truncated.
- Store budget metadata in structured content and benchmark rows.
- Preserve raw artifacts before compression where current code already does so.

### File Changes

| File | Change |
| --- | --- |
| `src/budget.ts` | New budget helper. |
| `src/log-compressor.ts` | Accept adaptive budget metadata. |
| `src/mcp.ts` | Apply adaptive budgets to read/search/run output. |
| `src/config.ts` | Keep current config names as hard ceilings. |
| `test/*` | Add budget selection tests. |

### Acceptance Criteria

- Existing config values remain valid and act as ceilings.
- Large JSON/build/error outputs shrink versus current fixed limits.
- High-signal failure lines remain present in compressor tests.
- Raw artifact paths remain available for command output where applicable.

## Phase 5: Router Calibration Before Semantic Routing

### Problem

The research recommends semantic task classification. The current repo already
has a deterministic router with task classes, playbooks, and negative controls.
A sidecar classifier should not be added until current misroutes are measured.

### Design

Add router calibration data to suite benchmark rows:

- `expected_task_class`
- `actual_task_class`
- `route_correct`
- `route_regret_reason`
- `negative_control_triggered`
- `fallback_after_answerable`

Use benchmark suite metadata as the source of expected route labels where
available. For old suite entries, allow labels to be absent.

### Acceptance Criteria

- Benchmark report can show route confusion by task class.
- At least one negative-control test covers small repo exact target bypass.
- No semantic model or embedding dependency is introduced.
- Follow-up router changes must be driven by a failing route bucket.

## Deferred Work

These ideas remain valid but should not block the first implementation pass.

| Idea | Defer until |
| --- | --- |
| Embedding or semantic classifier | Route confusion data shows deterministic rules cannot cover a high-volume class. |
| Model/NLP semantic log extraction | Regex compressors fail quality fixtures after adaptive budget work. |
| Context pruning/compaction | Host integration can actually remove or summarize context, not just emit hints. |
| MCP batch read/search tools | Benchmarks show per-call overhead dominates after cache/index work. |
| Multi-framework assemblers | Specific target repos justify React/Django/Express/K8s evidence packets. |
| Precise tokenizer dependency | Ratio estimator drift materially harms gate decisions. |

## Implementation Order

1. Phase 0 measurement metadata.
2. Phase 1 token estimator.
3. Phase 2 repo fingerprint and evidence cache.
4. Phase 3 persistent symbol index.
5. Phase 4 adaptive budgets.
6. Phase 5 router calibration.

This order is intentional: later phases depend on trustworthy estimates,
fingerprints, and benchmark fields.

## Test Plan

Run after each phase:

```powershell
cmd /c npm test
```

Focused checks:

```powershell
cmd /c npm run build
node --test test/coding-layer.test.mjs
node --test test/mcp.test.mjs
node --test test/mvp-router-shadow-compressors.test.mjs
node --test test/suite-benchmark-metadata.test.mjs
```

Benchmark checks after Phase 4:

```powershell
node dist/cli.js benchmark daily --repo . --mode baseline,router-best,compiled-hard-gate --repeat 3 --randomize --out benchmark-results/token-optimization-daily.json
node dist/cli.js benchmark suite --suite examples/contextgate-37-prompt-suite.example.json --repo . --mode baseline,router-best --out benchmark-results/token-optimization-suite.json --markdown benchmark-results/token-optimization-suite.md
```

The suite command may skip tasks whose `project` metadata does not match this
repo. That is acceptable for local smoke testing; run the complete suite against
the intended target repos before making product claims.

## Rollback Plan

- Token estimator: keep old `estimateTokens` wrapper exported from
  `log-compressor.ts` until all internal call sites migrate.
- Evidence cache: allow disabling with an environment variable if cache behavior
  is suspect.
- Symbol index: fall back to current full-scan path when index load fails.
- Adaptive budgets: config values remain hard ceilings, so rollback can set caps
  to current values.
- Router calibration: metadata-only changes should be safe to keep even if route
  tuning is reverted.

## Compatibility Requirements

- Existing MCP tool names and input schemas must remain compatible.
- `tokenopt_compile_evidence` compact output must stay compact by default.
- `detail=full` and `include_structured_packet=true` must continue to work.
- Hook behavior for `hard`, `shadow`, and `off` answerability gate modes must not
  change unless a phase explicitly updates tests and docs.
- Existing config files must not require migration.

## Open Questions

1. Should evidence cache be enabled by default immediately, or start behind
   `TOKENOPT_EVIDENCE_CACHE=1` for one release?
2. Should the symbol index include only symbols, or also reusable test-neighbor
   metadata?
3. What quality floor should block hard-gate rollout on the full 37-prompt suite:
   no score drop, or a small allowed delta such as `-0.02`?
4. Should precise tokenizer support be optional via dynamic import later, or kept
   out of the CLI to avoid packaging weight?

## Done Definition

The optimization pass is done when:

- All direct production `chars / 4` estimators are centralized.
- Evidence state invalidates on repo changes.
- Repeated coding coverage queries reuse a persisted index.
- Compression/read budgets are deterministic and task-aware.
- Benchmark output reports cache/index/budget metadata.
- Existing tests pass.
- A benchmark report shows token impact and quality impact side by side.
