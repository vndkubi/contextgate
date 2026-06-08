# TokenOpt CLI

TokenOpt is a reusable context-budget middleware for coding agents. V1 is Codex-first and ships as a global npm CLI, while the core policy engine stays independent from CodeGraph and other repository indexers.

## Install Locally

Full setup guide: [SETUP.md](SETUP.md).
Copilot-specific setup: [COPILOT_SETUP.md](COPILOT_SETUP.md).

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
tokenopt setup copilot --scope user|repo|both [--no-agents] [--no-run-command]
tokenopt install copilot --scope user|repo|both [--no-agents] [--no-run-command]
tokenopt hook codex user-prompt-submit|pre-tool-use|post-tool-use|pre-compact
tokenopt exec -- <command...>
tokenopt mcp
tokenopt benchmark daily --repo <path> [--task all] [--mode all] [--out results.json]
tokenopt benchmark codex-daily --repo <path> [--mode all] [--out results.json]
tokenopt instructions audit
tokenopt instructions emit --target agents|codex|copilot
tokenopt instructions install --target agents|codex|copilot
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
args = ["D:\\Personal\\Projects\\tokenopt\\dist\\cli.js", "mcp"]
required = true
default_tools_approval_mode = "approve"
```

This exposes:

```text
tokenopt_compile_evidence
tokenopt_run_command
tokenopt_search
tokenopt_read_file
tokenopt_project_facts
```

In this mode, shell commands, searches, and file reads can be routed through TokenOpt-controlled tools that deny broad reads/searches, return bounded file slices, compress command output, and preserve raw logs under the user cache.

`tokenopt_compile_evidence` is the preferred first call for onboarding/build-handoff tasks. It returns an answerability packet with coverage, evidence IDs, missing items, allowed followups, disallowed followups, and a recommended next action. If the packet is `answerable=true` and recommends `answer_now`, TokenOpt stores short-lived repo state and gates redundant MCP searches/reads/commands with a compact "answer now" response.

MCP tools also need agent instructions. Emit or install the reusable prompt snippet:

```bash
node dist/cli.js instructions emit --target agents
node dist/cli.js instructions install --target agents
node dist/cli.js instructions install --target copilot
```

`agents`/`codex` writes `AGENTS.md`; `copilot` writes `.github/copilot-instructions.md`. The installed block tells agents to call `tokenopt_compile_evidence` first, answer from the packet when `answerable=true`, and avoid shell fallback after the answerability gate.

For Copilot CLI, use the one-command project setup:

```powershell
node D:\Personal\Projects\tokenopt\dist\cli.js setup copilot --scope both
node D:\Personal\Projects\tokenopt\dist\cli.js doctor copilot
```

This installs `.github/copilot-instructions.md`, `AGENTS.md`, and merges a `tokenopt` stdio MCP server into `%USERPROFILE%\.copilot\mcp-config.json` using `node <absolute-tokenopt-cli-js> mcp`. It does not install Copilot hooks yet; TokenOpt's Copilot integration is MCP + instructions today.

## Benchmark

Run the repeatable acquisition benchmark:

```bash
node dist/cli.js benchmark daily --repo D:\Personal\Projects\elasticsearch --repo D:\Personal\Projects\hadoop --task all --mode all --show-answers --out benchmark-results\daily-large-repos.json
```

The benchmark reports model-visible tool input/output chars, final output chars, estimated input/output/total tokens, quality score, quality checks, tool calls, MCP calls, shell calls, and fallback-after-answerable for:

```text
baseline
compiled-packet
compiled-packet+gate
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

Quality is scored by deterministic rubric checks against the generated benchmark answer. This measures the acquisition layer and answer-readiness directly. It does not replace a full model E2E judge; use it to verify whether TokenOpt reduces evidence replay before running agent-level A/B tests.

For agent-level measurement through the real Codex CLI:

```bash
node dist/cli.js benchmark codex-daily --repo D:\Personal\Projects\tokenopt --task build-handoff --mode all --show-answers --out benchmark-results\codex-daily-tokenopt.json
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

Task sets:

```text
daily: build handoff, investigate, business/domain research, implement handoff, unit-test handoff.
realistic: investigate primary flow, PBI/requirement implementation plan, unit-test plan for likely owning class/module, requirement WHAT/WHY/HOW/acceptance criteria analysis, and repo benchmark/evaluation material analysis.
all: daily + realistic.
```

The Codex benchmark rows also include `answerablePackets` and `fallbackAfterAnswerable`. A non-zero fallback means the agent kept exploring after TokenOpt had already marked the packet answerable.
