# TokenOpt + GitHub Copilot Setup

This guide is for GitHub Copilot surfaces. TokenOpt currently supports Copilot through MCP and custom instructions. A native Copilot hook adapter is not implemented yet.

## What Works Today

Implemented:

- TokenOpt MCP stdio server: `tokenopt mcp`
- Copilot custom instructions: `.github/copilot-instructions.md`
- Agent instructions: `AGENTS.md`
- Instruction audit: `tokenopt instructions audit`

Not implemented yet:

- `tokenopt install copilot`
- `tokenopt hook copilot ...`
- Copilot hook JSON adapter
- Copilot-specific benchmark runner

## Prerequisites

- Node.js `>=20`
- npm
- `rg` / ripgrep on PATH
- TokenOpt built locally:

```powershell
cd D:\Personal\Projects\tokenopt
npm.cmd install
npm.cmd run build
node dist\cli.js doctor
```

On Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked.

## Setup Option A: Copilot CLI Local MCP

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

## Setup Option B: Interactive `/mcp add`

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

## Setup Option C: GitHub.com Copilot Cloud Agent / Code Review

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

Future adapter shape:

```text
tokenopt install copilot --scope user|repo
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
