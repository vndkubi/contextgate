import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adaptDecisionToCodex, normalizeCodexEvent } from "../dist/codex-adapter.js";
import { buildCopilotCloudMcpConfig, setupCopilotProject } from "../dist/copilot-setup.js";
import { buildNativePromptPack, emitTokenOptInstructions, installNativePromptPack, installTokenOptInstructions } from "../dist/instruction-audit.js";
import { compressText } from "../dist/log-compressor.js";
import { buildCodexHooksConfig, installCodexHooks } from "../dist/install.js";
import { repoKey } from "../dist/observability.js";

test("codex adapter emits deny shape for PreToolUse", () => {
  const output = adaptDecisionToCodex("pre-tool-use", {
    action: "deny",
    reason: "blocked"
  });
  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "blocked"
    }
  });
});

test("codex raw hook normalizes supported event", () => {
  const event = normalizeCodexEvent({
    hook_event_name: "UserPromptSubmit",
    cwd: "/tmp/repo",
    prompt: "hello"
  });
  assert.equal(event.eventName, "user-prompt-submit");
  assert.equal(event.prompt, "hello");
});

test("compressor extracts failure signal", () => {
  const result = compressText("FAIL src/example.test.ts\nAssertionError: expected 1 to be 2\n".repeat(50), 2000);
  assert.equal(result.kind, "vitest");
  assert.match(result.text, /AssertionError/);
  assert.ok(result.estimatedTokensSaved > 0);
});

test("compressor recognizes pytest output", () => {
  const result = compressText("FAILED tests/test_api.py::test_create_user - AssertionError\nTraceback (most recent call last):\n".repeat(20), 2000);
  assert.equal(result.kind, "pytest");
  assert.match(result.text, /test_create_user/);
});

test("compressor recognizes TypeScript output", () => {
  const result = compressText("src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n".repeat(20), 2000);
  assert.equal(result.kind, "tsc");
  assert.match(result.text, /TS2322/);
});

test("compressor recognizes ESLint output", () => {
  const result = compressText("src/index.ts:4:10: error  'x' is defined but never used  no-unused-vars\n".repeat(20), 2000);
  assert.equal(result.kind, "eslint");
  assert.match(result.text, /no-unused-vars/);
});

test("compressor falls back to generic output", () => {
  const result = compressText("plain log line\n".repeat(20), 2000);
  assert.equal(result.kind, "generic");
  assert.match(result.text, /plain log line/);
});

test("Codex hook config uses absolute node command style", () => {
  const hooks = buildCodexHooksConfig(path.resolve("dist/cli.js"));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;
  const commandWindows = hooks.hooks.PreToolUse[0].hooks[0].commandWindows;
  assert.match(command, /node(?:\.exe)?"/i);
  assert.match(command, /hook/);
  assert.equal(commandWindows, command);
  assert.doesNotMatch(command, /\bnpm\b/);
});

test("install keeps non-TokenOpt hooks and replaces TokenOpt hooks", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-install-"));
  const codexDir = path.join(repo, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const hooksPath = path.join(codexDir, "hooks.json");
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo keep", statusMessage: "Keep" }]
          }
        ]
      }
    })
  );
  installCodexHooks("repo", repo);
  const written = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(written.hooks.PreToolUse.length, 2);
  assert.equal(written.hooks.PreToolUse[0].hooks[0].command, "echo keep");
});

test("repo keys differ for unrelated roots", () => {
  assert.notEqual(repoKey(path.join(os.tmpdir(), "repo-a")), repoKey(path.join(os.tmpdir(), "repo-b")));
});

test("instruction emitter and installer produce idempotent MCP guidance", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-instructions-"));
  const snippet = emitTokenOptInstructions("agents");
  assert.match(snippet, /tokenopt_compile_evidence/);
  assert.match(snippet, /answerable=true/);

  const agentsPath = installTokenOptInstructions(repo, "agents");
  installTokenOptInstructions(repo, "agents");
  const agentsText = fs.readFileSync(agentsPath, "utf8");
  assert.equal((agentsText.match(/tokenopt:mcp-instructions:start/g) ?? []).length, 1);
  assert.match(agentsText, /Do not bypass TokenOpt with shell fallback/);
  assert.match(agentsText, /MCP\+shell double-spend/);

  const copilotPath = installTokenOptInstructions(repo, "copilot");
  assert.equal(copilotPath, path.join(repo, ".github", "copilot-instructions.md"));
  assert.match(fs.readFileSync(copilotPath, "utf8"), /TokenOpt MCP Usage/);

  const copilotPathInstructionsPath = installTokenOptInstructions(repo, "copilot-path");
  assert.equal(copilotPathInstructionsPath, path.join(repo, ".github", "instructions", "tokenopt.instructions.md"));
  assert.match(fs.readFileSync(copilotPathInstructionsPath, "utf8"), /applyTo: "\*\*"/);

  const copilotAgentPath = installTokenOptInstructions(repo, "copilot-agent");
  assert.equal(copilotAgentPath, path.join(repo, ".github", "agents", "tokenopt-cost-gate.agent.md"));
  assert.match(fs.readFileSync(copilotAgentPath, "utf8"), /name: tokenopt-cost-gate/);
  assert.match(fs.readFileSync(copilotAgentPath, "utf8"), /tokenopt\/tokenopt_compile_evidence/);
});

test("native prompt pack installs reusable Copilot prompt files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-native-prompts-"));
  const plan = buildNativePromptPack(repo);
  assert.equal(plan.files.length, 6);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "write-unittest.prompt.md"))), true);

  const files = installNativePromptPack(repo);
  assert.equal(files.length, 6);
  const writeUnittest = fs.readFileSync(path.join(repo, ".github", "prompts", "write-unittest.prompt.md"), "utf8");
  assert.match(writeUnittest, /name: write-unittest/);
  assert.match(writeUnittest, /coding_coverage once/);
  assert.match(writeUnittest, /at most one additional allowed MCP followup/);

  const securityAudit = fs.readFileSync(path.join(repo, ".github", "prompts", "security-audit.prompt.md"), "utf8");
  assert.match(securityAudit, /name: security-audit/);
  assert.match(securityAudit, /Use security_audit route/);
  assert.match(securityAudit, /never use broad shell review fallback/i);
});

test("Copilot setup writes repo guidance and merges user MCP config", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-copilot-"));
  const copilotConfigPath = path.join(repo, "mcp-config.json");
  const tokenoptCliPath = path.resolve("dist/cli.js");
  fs.writeFileSync(
    copilotConfigPath,
    JSON.stringify({
      mcpServers: {
        keep: {
          type: "http",
          url: "https://example.test/mcp",
          tools: ["*"]
        }
      }
    }, null, 2)
  );

  const result = setupCopilotProject({
    repoRoot: repo,
    scope: "both",
    copilotConfigPath,
    tokenoptCliPath
  });
  setupCopilotProject({
    repoRoot: repo,
    scope: "both",
    copilotConfigPath,
    tokenoptCliPath
  });

  const copilotInstructions = fs.readFileSync(path.join(repo, ".github", "copilot-instructions.md"), "utf8");
  const copilotPathInstructions = fs.readFileSync(path.join(repo, ".github", "instructions", "tokenopt.instructions.md"), "utf8");
  const copilotAgent = fs.readFileSync(path.join(repo, ".github", "agents", "tokenopt-cost-gate.agent.md"), "utf8");
  const writeUnittestPrompt = fs.readFileSync(path.join(repo, ".github", "prompts", "write-unittest.prompt.md"), "utf8");
  const agentsInstructions = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf8"));

  assert.equal((copilotInstructions.match(/tokenopt:mcp-instructions:start/g) ?? []).length, 1);
  assert.match(copilotPathInstructions, /applyTo: "\*\*"/);
  assert.match(copilotPathInstructions, /TokenOpt MCP Usage/);
  assert.match(copilotAgent, /name: tokenopt-cost-gate/);
  assert.match(copilotAgent, /tokenopt\/tokenopt_compile_evidence/);
  assert.match(writeUnittestPrompt, /name: write-unittest/);
  assert.equal(result.promptFiles.length, 6);
  assert.equal((agentsInstructions.match(/tokenopt:mcp-instructions:start/g) ?? []).length, 1);
  assert.deepEqual(config.mcpServers.keep.tools, ["*"]);
  assert.equal(config.mcpServers.tokenopt.command, "node");
  assert.deepEqual(config.mcpServers.tokenopt.args, [tokenoptCliPath.replace(/\\/g, "/"), "mcp", "--mode", "lite"]);
  assert.ok(config.mcpServers.tokenopt.tools.includes("tokenopt_compile_evidence"));
  assert.ok(!config.mcpServers.tokenopt.tools.includes("tokenopt_run_command"));
  assert.ok(!config.mcpServers.tokenopt.tools.includes("tokenopt_project_facts"));
  assert.doesNotMatch(JSON.stringify(config.mcpServers.tokenopt), /\bnpm(?:\.cmd|\.ps1)?\b/i);
  assert.ok(result.warnings.some((warning) => /lite mode/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /hooks were not installed/i.test(warning)));
});

test("Copilot cloud MCP example excludes command execution by default", () => {
  const config = JSON.parse(buildCopilotCloudMcpConfig());
  assert.equal(config.mcpServers.tokenopt.command, "npx");
  assert.deepEqual(config.mcpServers.tokenopt.args, ["-y", "@tokenopt/cli", "mcp", "--mode", "lite"]);
  assert.ok(config.mcpServers.tokenopt.tools.includes("tokenopt_compile_evidence"));
  assert.ok(!config.mcpServers.tokenopt.tools.includes("tokenopt_run_command"));
});
