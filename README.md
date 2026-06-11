# TokenOpt CLI

TokenOpt is a reusable context-budget middleware for coding agents. V1 is Codex-first and ships as a global npm CLI, while the core policy engine stays independent from CodeGraph and other repository indexers.

## Install Locally

Full setup guide: [SETUP.md](SETUP.md).
Copilot-specific setup: [COPILOT_SETUP.md](COPILOT_SETUP.md).
Project idea and architecture: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).
Prompt and benchmark-backed routing playbook: [PROMPT_PLAYBOOK.md](PROMPT_PLAYBOOK.md).

```bash
npm install
npm run build
node dist/cli.js doctor
```

On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`:

```powershell
cmd /c npm install
cmd /c npm run build
node dist/cli.js doctor
```

## Commands

```text
tokenopt init
tokenopt install codex --scope user|repo
tokenopt setup copilot --scope user|repo|both [--no-agents] [--no-prompts] [--include-run-command]
tokenopt install copilot --scope user|repo|both [--no-agents] [--no-prompts] [--include-run-command]
tokenopt hook codex user-prompt-submit|pre-tool-use|post-tool-use|pre-compact
tokenopt hook copilot user-prompt-submit|pre-tool-use|post-tool-use|pre-compact
tokenopt exec -- <command...>
tokenopt mcp [--mode lite|full]
tokenopt benchmark daily --repo <path> [--task all] [--mode all] [--repeat 5] [--randomize] [--out results.json]
tokenopt benchmark codex-daily --repo <path> [--mode all] [--out results.json]
tokenopt instructions audit
tokenopt instructions emit --target agents|codex|copilot|copilot-path|copilot-agent
tokenopt instructions graph
tokenopt instructions prompts
tokenopt instructions install-graph
tokenopt instructions install-prompts
tokenopt instructions install --target agents|codex|copilot|copilot-path|copilot-agent
tokenopt report
tokenopt doctor
tokenopt doctor copilot
```

Config precedence is:

```text
built-in defaults -> ~/.tokenopt/config.json -> <repo>/.tokenopt/config.json -> env/CLI flags
```

The Codex installer writes hook commands as absolute `node <tokenopt-bin-js>` invocations, avoiding npm and shell shim differences across Windows, macOS, and Linux.

## Gated MCP Mode

Codex hooks are useful when they fire, but they are not the only way to route agent work through TokenOpt. For stricter enforcement, disable Codex's built-in shell tool and add TokenOpt as an MCP stdio server:

```toml
[features]
shell_tool = false

[mcp_servers.tokenopt]
command = "node"
args = ["<tokenopt-repo>/dist/cli.js", "mcp", "--mode", "lite"]
required = true
default_tools_approval_mode = "approve"
```

By default, `tokenopt mcp` runs in `lite` mode to reduce MCP tool-schema/context overhead. Lite mode exposes:

```text
tokenopt_compile_evidence
tokenopt_search
tokenopt_read_file
```

Use `tokenopt mcp --mode full` only when you want command execution, standalone project facts, and task-shaped Java/review/debug helpers exposed:

```text
tokenopt_run_command
tokenopt_project_facts
tokenopt_prepare_java_diff
tokenopt_jakarta_annotation_filter
tokenopt_assemble_spring_context
tokenopt_business_contract
tokenopt_impact_analysis
tokenopt_symbols_find
tokenopt_symbol_packet
tokenopt_test_neighbors
tokenopt_failure_packet
```

In this mode, shell commands, searches, and file reads can be routed through TokenOpt-controlled tools that deny broad reads/searches, return bounded file slices, compress command output, and preserve raw logs under the user cache.

Full mode also exposes the regex-lite Coding Coverage Layer. For `implement`, `write_unittest`, and failure/debug tasks, `tokenopt_compile_evidence` now requires exact coding coverage before `answerable=true`: target symbol, signature or definition slice, dependencies/usages, test neighbors/style, build/test command, and parsed failure context when available. Missing coverage returns exact followups such as `tokenopt_symbols_find`, `tokenopt_symbol_packet`, `tokenopt_test_neighbors`, or `tokenopt_failure_packet` instead of treating repo inventory as enough context.

`rg` is only the fast search provider, not a hard requirement. MCP search and project inventory try providers in this order: `rg`, `git`, then a bounded built-in Node scanner. Tool output includes `searchProvider` so benchmark reports and agent transcripts show which provider was used instead of stopping at "rg not found".

`tokenopt_compile_evidence` is a cost gate, not a mandatory extra step. Use it first when it can replace broad exploration: onboarding/build handoff, repo overview, business/domain summary from docs/inventory, implementation planning, and unit-test planning. Do not use MCP-first for exact existing-flow, class, method, or PBI deep dives when the agent will still need native shell/search reads; that hybrid path spends MCP context and then pays the normal shell cost again. For those tasks, either use normal narrow shell/search directly or run a strict MCP-only session with shell disabled. If the packet is `answerable=true` and recommends `answer_now`, TokenOpt stores short-lived repo state and gates redundant MCP searches/reads/commands with a compact "answer now" response. Codex hooks can also deny shell grep/search after an answerable packet, or after a non-answerable packet has TokenOpt followups; MCP alone cannot disable a host shell tool.

Prompts that require an artifact but do not include one now use `needs_input_bypass`. Examples include PBI planning without PBI text, requirement analysis without a requirement, unit-test planning without a target class/module/behavior, review-memory promotion without completed-task evidence, and review prompts without a concrete diff or scope. `tokenopt_compile_evidence` returns a small `answerable=false` packet with `recommended_next_action=ask_user`, `max_additional_calls=0`, and no repository inventory scan.

Security review uses a separate `security_audit` route instead of generic review fallback. It requires scope plus security-specific coverage for input boundaries, auth/authz, validation/deserialization, secrets/config/dependencies, and tests or guardrails before `answerable=true`. Without that coverage, TokenOpt allows only exact followups or asks for the missing scope; it does not encourage broad shell exploration.

When a prompt names a specific target such as a module, class, route, flow, or business capability, TokenOpt requires packet evidence to mention that target before `answerable=true`. If target-specific evidence is missing, the packet stays `answerable=false`, marks `target_specific_evidence=missing`, and returns exact TokenOpt followups instead of letting the agent switch to raw shell/search.

For coding tasks, target matching is stricter than suffix matching. A request for `UnknownBillingService` cannot be marked covered just because another `*Service` symbol exists; the packet stays non-answerable until the exact target is found or the agent follows the bounded coverage followups.

To avoid MCP overhead becoming larger than the saved context, `tokenopt_compile_evidence` returns compact output by default and only returns a small `packetSummary` in structured content. The full packet is stored in `state_path`. Use `detail=full` or `include_structured_packet=true` only for debugging, quality audits, or benchmark reports.

MCP tools also need agent instructions. Emit or install the reusable prompt snippet:

```bash
node dist/cli.js instructions emit --target agents
node dist/cli.js instructions install --target agents
node dist/cli.js instructions install --target copilot
node dist/cli.js instructions install --target copilot-path
node dist/cli.js instructions install --target copilot-agent
node dist/cli.js instructions graph
node dist/cli.js instructions install-graph
node dist/cli.js instructions prompts
node dist/cli.js instructions install-prompts
```

`agents`/`codex` writes `AGENTS.md`; `copilot` writes `.github/copilot-instructions.md`; `copilot-path` writes `.github/instructions/tokenopt.instructions.md` with `applyTo: "**"`; `copilot-agent` writes `.github/agents/tokenopt-cost-gate.agent.md`; `instructions install-prompts` writes `.github/prompts/*.prompt.md` for native Copilot slash prompts. The prompt pack covers business deep dives, flow traces, trace-bug, implementation and PBI planning, requirement analysis, unit tests, review/security, refactor scope, performance/dependency/context analysis, onboarding/build handoff, and SpecKit planning. These files tell agents to use TokenOpt as a cost gate, answer from the packet when `answerable=true`, and avoid MCP-first plus shell fallback for exact code-flow/class/PBI tasks.

`instructions graph` plans a shorter root instruction plus path-specific review/runtime instruction files. `instructions install-graph` writes that graph with TokenOpt markers so root guidance stays small while review/debug guidance stays near relevant paths.

For Copilot CLI, use the one-command project setup:

```powershell
node <tokenopt-repo>\dist\cli.js setup copilot --scope both
node <tokenopt-repo>\dist\cli.js doctor copilot
```

This installs `.github/copilot-instructions.md`, `.github/instructions/tokenopt.instructions.md`, `.github/agents/tokenopt-cost-gate.agent.md`, `AGENTS.md`, `.github/prompts/*.prompt.md`, and merges a lite `tokenopt` stdio MCP server into `<home>/.copilot/mcp-config.json` using `node <absolute-tokenopt-cli-js> mcp --mode lite`. It does not install Copilot hooks yet; TokenOpt's Copilot integration is MCP + instructions + native prompt files today. Add `--include-run-command` only for repos where Copilot should run builds/tests through TokenOpt MCP.

After setup, use Copilot/Codex normally. In Copilot UI, call native slash prompts such as `/trace-bug <failing test or stack frame>`, `/write-unittest OrderService payment authorization`, or `/security-audit <diff or PR scope>`. In Codex, type natural tasks; `AGENTS.md` carries the routing rules.

## Benchmark

Run the repeatable acquisition benchmark:

```bash
node dist/cli.js benchmark daily --repo <repo-a> --repo <repo-b> --task all --mode all --repeat 5 --randomize --show-answers --out benchmark-results/daily-large-repos.json
```

The benchmark reports model-visible tool input/output chars, final output chars, estimated input/output/total tokens, quality score, quality checks, tool calls, MCP calls, shell calls, route decision, router regret, estimated avoided tokens, and fallback-after-answerable. `--repeat` and `--randomize` support multi-run randomized order checks. `gold-packet` is an oracle/gold-packet upper-bound diagnostic.

```text
baseline
compiled-packet
compiled-shadow-gate
compiled-packet+gate
router-best
router-shadow-gate
router-shadow-gate+compressors
gold-packet
oracle-packet
```

Daily tasks:

```text
build-handoff
investigate
research-business
implement
write-unittest
```

The complete research suite is available at `examples/contextgate-37-prompt-suite.example.json` and can be run with:

```bash
node dist/cli.js benchmark suite --suite examples/contextgate-37-prompt-suite.example.json --repo <target-repo> --mode baseline,router-best --max-tasks 37 --markdown benchmark-results/complete-suite.md --out benchmark-results/complete-suite.json
```

Quality is scored by deterministic rubric checks against the generated benchmark answer. This measures the acquisition layer and answer-readiness directly. It does not replace a full model E2E judge; use it to verify whether TokenOpt reduces evidence replay before running agent-level A/B tests.

For agent-level measurement through the real Codex CLI:

```bash
node dist/cli.js benchmark codex-daily --repo <target-repo> --task build-handoff --mode all --show-answers --out benchmark-results/codex-daily-target.json
```

This runner executes `npx @openai/codex@0.137.0 exec --json`, parses `turn.completed.usage`, counts shell and MCP tool calls, records raw JSONL logs, and scores the final Codex answer with the same task rubric.

Modes:

```text
baseline: natural task prompt with normal Codex tools.
tokenopt-mcp: MCP enabled and the benchmark prompt explicitly names tokenopt_compile_evidence.
tokenopt-mcp-instructed: natural user prompt; TokenOpt routing comes only from injected project/agent instructions.
tokenopt-mcp+gate: MCP mode plus a deliberate redundant followup to verify answerability gating.
```

Use `tokenopt-mcp-instructed` when proving whether normal prompts like "Investigate flow X" or "write unittest for class Y" route through TokenOpt after setup. The JSON rows include `userPrompt`, `injectedInstruction`, and `prompt` so the benchmark shows what the user wrote versus what the agent setup supplied.

Do not paste `injectedInstruction`, `actualPromptSentToCodex`, or text such as `Project instruction injected by TokenOpt setup:` into a normal user prompt. Those fields are benchmark/report artifacts. A real prompt should contain only the actual task; repo instructions and MCP config supply TokenOpt guidance separately.

Task sets:

```text
daily: build handoff, investigate, business/domain research, implement handoff, unit-test handoff.
realistic: investigate primary flow, PBI/requirement implementation plan, unit-test plan for likely owning class/module, requirement WHAT/WHY/HOW/acceptance criteria analysis, and repo benchmark/evaluation material analysis.
all: daily + realistic.
```

The Codex benchmark rows also include `answerablePackets` and `fallbackAfterAnswerable`. A non-zero fallback means the agent kept exploring after TokenOpt had already marked the packet answerable.
