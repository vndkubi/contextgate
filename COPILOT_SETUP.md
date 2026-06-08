# TokenOpt + GitHub Copilot Setup

This guide is for GitHub Copilot surfaces. TokenOpt currently supports Copilot through MCP and custom instructions. A native Copilot hook adapter is not implemented yet.

## What Works Today

Implemented:

- TokenOpt MCP stdio server: `tokenopt mcp`
- One-command project setup: `tokenopt setup copilot`
- Alias for install flows: `tokenopt install copilot`
- Copilot custom instructions: `.github/copilot-instructions.md`
- Agent instructions: `AGENTS.md`
- Instruction audit: `tokenopt instructions audit`
- Copilot setup verification: `tokenopt doctor copilot`

Not implemented yet:

- `tokenopt hook copilot ...`
- Copilot hook JSON adapter
- Copilot-specific benchmark runner

## What Needs Setup For Copilot?

| Surface | Needed? | TokenOpt setup |
| --- | --- | --- |
| MCP server | Yes | `tokenopt setup copilot --scope user` merges `tokenopt` into `%USERPROFILE%\.copilot\mcp-config.json`. |
| Repo instructions | Yes | `tokenopt setup copilot` writes `.github/copilot-instructions.md`. |
| Agent instructions | Recommended | `tokenopt setup copilot` writes `AGENTS.md` by default; use `--no-agents` to skip. |
| Skills | No for V1 | TokenOpt is not packaged as a Copilot skill. MCP + instructions are enough for current behavior. |
| Hooks | Not yet | Do not install Copilot hooks until `tokenopt hook copilot ...` exists. |

Scope meaning:

```text
--scope user  -> repo instructions + local Copilot CLI MCP config
--scope repo  -> repo instructions only; use after user MCP is installed, or pair with GitHub.com cloud MCP settings
--scope both  -> repo instructions + local Copilot CLI MCP config + cloud setup guidance
```

## Prerequisites

- Node.js `>=20`
- npm
- TokenOpt built locally:

Optional:

- `rg` / ripgrep on PATH for faster MCP search. If unavailable or blocked, TokenOpt falls back to `git`, then a bounded built-in Node scanner.

```powershell
cd D:\Personal\Projects\tokenopt
npm.cmd install
npm.cmd run build
node dist\cli.js doctor
```

On Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked.

## Setup Option A: Auto Setup For A Project

Use this for each repo where Copilot should use TokenOpt:

```powershell
cd D:\Personal\Projects\your-repo
node D:\Personal\Projects\tokenopt\dist\cli.js setup copilot --scope both
node D:\Personal\Projects\tokenopt\dist\cli.js doctor copilot
```

Expected result:

```text
.github/copilot-instructions.md
AGENTS.md
%USERPROFILE%\.copilot\mcp-config.json
```

`%USERPROFILE%\.copilot\mcp-config.json` is user-global for Copilot CLI. Once the `tokenopt` MCP server is installed there, it is available from other local repos too. The repo instruction files are still project-specific, so run `tokenopt setup copilot --scope repo` inside each project that should steer Copilot toward TokenOpt.

Useful variants:

```powershell
# Only install repo instructions; do not touch user MCP config.
node D:\Personal\Projects\tokenopt\dist\cli.js setup copilot --scope repo

# Install local Copilot CLI MCP config and repo instructions, but skip AGENTS.md.
node D:\Personal\Projects\tokenopt\dist\cli.js setup copilot --scope user --no-agents

# Safer allowlist for environments where command execution should not be exposed.
node D:\Personal\Projects\tokenopt\dist\cli.js setup copilot --scope user --no-run-command
```

The generated MCP entry uses:

```json
{
  "type": "local",
  "command": "node",
  "args": ["D:/Personal/Projects/tokenopt/dist/cli.js", "mcp"]
}
```

It deliberately avoids `npm`, `npm.ps1`, and PowerShell shims.

## Setup Option B: Manual Copilot CLI Local MCP

Use this when Copilot CLI runs on your machine and can access `D:\Personal\Projects\tokenopt`.

### 1. Create or edit Copilot MCP config

Copilot CLI reads MCP servers from:

```text
%USERPROFILE%\.copilot\mcp-config.json
```

Create the directory if needed:

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.copilot
notepad $env:USERPROFILE\.copilot\mcp-config.json
```

Add:

```json
{
  "mcpServers": {
    "tokenopt": {
      "type": "local",
      "command": "node",
      "args": ["D:/Personal/Projects/tokenopt/dist/cli.js", "mcp"],
      "env": {},
      "tools": [
        "tokenopt_compile_evidence",
        "tokenopt_search",
        "tokenopt_read_file",
        "tokenopt_run_command",
        "tokenopt_project_facts"
      ]
    }
  }
}
```

### 2. Add repo instructions

For each repo where Copilot should use TokenOpt:

```powershell
cd D:\Personal\Projects\your-repo
node D:\Personal\Projects\tokenopt\dist\cli.js instructions install --target copilot
node D:\Personal\Projects\tokenopt\dist\cli.js instructions install --target agents
```

This creates or updates:

```text
.github/copilot-instructions.md
AGENTS.md
```

The installed block tells Copilot:

- Call `tokenopt_compile_evidence` first.
- Use the right task type, such as `build_handoff`, `investigate`, `research_business`, `implement`, or `write_unittest`.
- If `answerable=true`, answer from the packet and do not run more shell/search calls.
- If `missing` is non-empty, use only `allowed_followups`.

The user does not need to mention `tokenopt_compile_evidence` in normal prompts. After setup, prompts such as:

```text
Investigate checkout flow failure
Based on this PBI, help me investigate and plan implementation
Please help me write unit tests for OrderService
```

should be routed by the instruction layer. The exact MCP tool name belongs in `.github/copilot-instructions.md`, `AGENTS.md`, or Codex hook context, not in every user prompt.

### 3. Verify inside Copilot CLI

Start Copilot CLI in the target repo:

```powershell
cd D:\Personal\Projects\your-repo
gh copilot
```

Inside Copilot CLI, check MCP status:

```text
/mcp show
/mcp show tokenopt
```

Then prompt:

```text
Use TokenOpt MCP first.
Call tokenopt_compile_evidence with task_type=build_handoff for this repo.
If answerable=true, answer from the packet and do not call shell/search again.
```

Expected behavior:

- Copilot sees `tokenopt` MCP.
- Copilot calls `tokenopt_compile_evidence`.
- If the packet is answerable, Copilot stops gathering evidence and answers.

## Setup Option C: Interactive `/mcp add`

If you prefer interactive setup:

1. Open Copilot CLI.
2. Run:

```text
/mcp add
```

3. Enter:

```text
Server Name: tokenopt
Server Type: Local or STDIO
Command: node D:/Personal/Projects/tokenopt/dist/cli.js mcp
Tools: tokenopt_compile_evidence,tokenopt_search,tokenopt_read_file,tokenopt_run_command,tokenopt_project_facts
```

4. Save with `Ctrl+S`.
5. Run:

```text
/mcp show tokenopt
```

## Setup Option D: GitHub.com Copilot Cloud Agent / Code Review

Do not use the local Windows path in cloud agent config:

```text
D:/Personal/Projects/tokenopt/dist/cli.js
```

That path exists only on your machine. GitHub.com Copilot cloud agent runs in an ephemeral Linux sandbox, so it cannot access your local `D:\...` repo.

For cloud agent or Copilot code review, TokenOpt must be available inside the cloud sandbox. That means one of these:

- Publish TokenOpt as an npm package and use `npx`.
- Check TokenOpt into the target repo and call it with a relative Linux path.
- Build a remote HTTP MCP server and configure Copilot to use that URL.

Example cloud-compatible MCP JSON after publishing:

```json
{
  "mcpServers": {
    "tokenopt": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@tokenopt/cli", "mcp"],
      "tools": [
        "tokenopt_compile_evidence",
        "tokenopt_search",
        "tokenopt_read_file",
        "tokenopt_project_facts"
      ]
    }
  }
}
```

Then configure it in the repository on GitHub.com:

```text
Repository -> Settings -> Copilot -> MCP servers
```

Important cloud caveats:

- Copilot cloud/code review can use MCP tools, but local filesystem paths from your PC will not exist.
- Allowlist specific tools instead of `*`.
- Avoid exposing `tokenopt_run_command` in cloud/code review unless you intentionally want command execution.
- Cloud agent runs non-interactively; do not rely on prompts for approval.

## Copilot Hooks Status

GitHub Copilot supports hooks, including `preToolUse`, `postToolUse`, and `userPromptSubmitted`, but TokenOpt does not yet ship a Copilot hook adapter.

Current recommendation:

```text
Use MCP + instructions for Copilot today.
Do not configure TokenOpt Copilot hooks until tokenopt hook copilot is implemented.
```

Already implemented MCP/instruction setup:

```text
tokenopt setup copilot --scope user|repo|both
tokenopt install copilot --scope user|repo|both
```

Future hook adapter shape:

```text
tokenopt hook copilot user-prompt-submitted|pre-tool-use|post-tool-use|agent-stop
```

The core TokenOpt state model is already reusable for this, but the Copilot input/output JSON schemas need a dedicated adapter.

## Recommended Prompt

Use this prompt pattern in Copilot:

```text
Use TokenOpt MCP first.
Call tokenopt_compile_evidence for this task.
If answerable=true and missing=[], answer from the evidence packet and do not call shell/search again.
If missing is non-empty, use only allowed_followups from the packet.

Task: <your actual task>
```

## Troubleshooting

If Copilot cannot see TokenOpt:

```text
/mcp show
/mcp show tokenopt
```

Check:

- `node` is on PATH.
- `D:/Personal/Projects/tokenopt/dist/cli.js` exists.
- `npm.cmd run build` was run after code changes.
- `mcp-config.json` is valid JSON.
- Tool names are allowlisted correctly.

If Copilot still uses shell too much:

- Confirm `.github/copilot-instructions.md` contains the TokenOpt block.
- Prompt explicitly: "Use TokenOpt MCP first."
- Ask it to call `tokenopt_compile_evidence` by name.
- Remove broad shell permissions only if your Copilot surface supports that control.

## References

- GitHub Copilot CLI MCP config: <https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
- GitHub Copilot custom instructions: <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>
- GitHub Copilot repository MCP config: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers>
- GitHub Copilot hooks reference: <https://docs.github.com/en/copilot/reference/hooks-reference>
