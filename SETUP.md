# TokenOpt Setup Guide

TokenOpt currently has four surfaces:

- MCP server: `tokenopt mcp`, the main optimized path.
- Codex hooks: guardrails for Codex hook events.
- Copilot setup: MCP config plus repository instructions.
- Benchmarks: deterministic acquisition benchmark and real `codex exec --json` benchmark.

For GitHub Copilot setup, see [COPILOT_SETUP.md](COPILOT_SETUP.md).

## Prerequisites

- Node.js `>=20`
- npm
- For agent-level benchmarks: `npx @openai/codex@0.137.0`

Optional:

- `rg` / ripgrep on PATH for faster MCP search. If unavailable or blocked, TokenOpt falls back to `git`, then a bounded built-in Node scanner.

On Windows PowerShell, prefer `.cmd` shims if `npm.ps1` is blocked:

```powershell
npm.cmd install
npm.cmd run build
```

## Local Build

From the TokenOpt repo:

```powershell
cd D:\Personal\Projects\tokenopt
npm.cmd install
npm.cmd run build
node dist\cli.js doctor
```

Initialize per-repo config when needed:

```powershell
node D:\Personal\Projects\tokenopt\dist\cli.js init
```

Config precedence:

```text
built-in defaults -> ~/.tokenopt/config.json -> <repo>/.tokenopt/config.json -> env/CLI flags
```

## Codex MCP Setup

This is the recommended mode for optimization because it makes TokenOpt the acquisition path instead of letting the agent freely alternate between shell and MCP.

Add this to `C:\Users\SonCao\.codex\config.toml`:

```toml
[mcp_servers.tokenopt]
command = "node"
args = ["D:/Personal/Projects/tokenopt/dist/cli.js", "mcp", "--mode", "lite"]
```

For strict runs, disable Codex's built-in shell tool and force the agent through TokenOpt MCP:

```powershell
npx.cmd -y @openai/codex@0.137.0 exec `
  --json `
  --ephemeral `
  --skip-git-repo-check `
  --disable shell_tool `
  -C D:\Personal\Projects\tokenopt `
  -c "mcp_servers.tokenopt.command='node'" `
  -c "mcp_servers.tokenopt.args=['D:/Personal/Projects/tokenopt/dist/cli.js','mcp','--mode','lite']" `
  "Use TokenOpt as a cost gate: call tokenopt_compile_evidence only when it can replace broad exploration, then answer from the packet if answerable=true."
```

TokenOpt MCP defaults to lite mode so the MCP tool schemas do not cost more context than they save. Lite mode exposes:

```text
tokenopt_compile_evidence
tokenopt_search
tokenopt_read_file
```

Full mode adds command execution and standalone project facts:

```text
node D:\Personal\Projects\tokenopt\dist\cli.js mcp --mode full
```

## Agent Instructions

MCP only exposes tools. The agent also needs instructions that tell it when TokenOpt is cheaper than normal exploration, and when to skip MCP-first to avoid double-spending context.

Preview the reusable instruction snippet:

```powershell
node D:\Personal\Projects\tokenopt\dist\cli.js instructions emit --target agents
```

Install it into repo instructions:

```powershell
cd D:\Personal\Projects\your-repo
node D:\Personal\Projects\tokenopt\dist\cli.js instructions install --target agents
```

Targets:

```text
agents  -> AGENTS.md
codex   -> AGENTS.md
copilot -> .github/copilot-instructions.md
```

The installed block is wrapped in markers:

```text
<!-- tokenopt:mcp-instructions:start -->
...
<!-- tokenopt:mcp-instructions:end -->
```

Running install again updates the existing block instead of appending duplicates.

Expected agent flow:

```text
1. Use TokenOpt first only when it can replace broad exploration.
2. Call tokenopt_compile_evidence({ task, task_type, cwd, budget_tokens, quality_rubric })
3. If answerable=true and recommended_next_action=answer_now, answer from the packet.
4. If missing items exist, use only allowed_followups in strict MCP-only mode; in shell-enabled sessions, do not do MCP-first plus shell fallback for exact code-flow/class/PBI tasks.
5. Redundant MCP exploration after answerable=true is gated.
6. With Codex hooks trusted, shell grep/search after a packet is denied when TokenOpt has already provided answer-now guidance or exact TokenOpt followups.
```

For prompts such as "understand checkout flow end-to-end so I can draw Mermaid", use TokenOpt only in strict MCP-only mode or when the packet can provide the full evidence path. In normal shell-enabled agent mode, start with narrow native search/read instead of calling TokenOpt first and then repeating the same work through shell. For prompts such as "study business and deep dive that business", TokenOpt can be useful because docs/inventory often provide enough evidence without shell fallback.

`tokenopt_compile_evidence` defaults to compact output. Full evidence is saved in `state_path`; pass `detail=full` only when debugging or producing a benchmark/audit report.

## Codex Hooks Setup

Hooks are useful as guardrails, but they are weaker than strict MCP mode because hook firing and trust are controlled by the host Codex environment.

Install hooks:

```powershell
node D:\Personal\Projects\tokenopt\dist\cli.js install codex --scope user
```

Then open Codex and run:

```text
/hooks
```

Review and trust the TokenOpt hook commands.

Verify hook canary:

```powershell
node D:\Personal\Projects\tokenopt\dist\cli.js doctor codex-hooks
```

If the WindowsApps `codex.exe` alias returns `Access is denied`, use:

```powershell
npx.cmd -y @openai/codex@0.137.0 exec --help
```

## Run Benchmarks

Deterministic acquisition benchmark:

```powershell
node dist\cli.js benchmark daily `
  --repo D:\Personal\Projects\elasticsearch `
  --repo D:\Personal\Projects\hadoop `
  --task all `
  --mode all `
  --show-answers `
  --out benchmark-results\daily-large-repos.json
```

Real Codex CLI benchmark:

```powershell
node dist\cli.js benchmark codex-daily `
  --repo D:\Personal\Projects\hadoop `
  --task build-handoff `
  --mode baseline,tokenopt-mcp `
  --show-answers `
  --out benchmark-results\codex-daily-hadoop-build.json
```

Modes:

```text
baseline: Codex CLI can use normal shell/tool behavior.
tokenopt-mcp: Codex CLI has shell_tool disabled and must use TokenOpt MCP.
tokenopt-mcp+gate: TokenOpt MCP plus an extra redundant call to verify the answerability gate.
```

Metrics recorded:

```text
input_tokens
cached_input_tokens
output_tokens
reasoning_output_tokens
tool_calls
mcp_calls
shell_calls
tool_input_chars
tool_output_chars
quality_score
quality_checks
raw JSONL log path
```

## Copilot Status

Copilot is implemented as MCP + instructions. Native Copilot hooks are not implemented yet.

Current support:

- TokenOpt MCP server: implemented.
- Codex hook adapter/install: implemented.
- Codex CLI benchmark runner: implemented.
- Copilot local CLI setup: `tokenopt setup copilot --scope user|repo|both`
- Copilot instruction install: `.github/copilot-instructions.md`
- Agent instruction install: `AGENTS.md`
- Copilot setup doctor: `tokenopt doctor copilot`

Not yet implemented:

- Copilot hook adapter
- Copilot hook output schema
- Copilot-specific benchmark runner

For a project-level setup:

```powershell
cd D:\Personal\Projects\your-repo
node D:\Personal\Projects\tokenopt\dist\cli.js setup copilot --scope both
node D:\Personal\Projects\tokenopt\dist\cli.js doctor copilot
```

The core policy and evidence packet model are reusable for Copilot hooks, but a separate hook adapter is still required.
