import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { getCliEntryPath } from "./codex-adapter.js";
import { getCodexHooksPath } from "./install.js";
import type { LoadedConfig } from "./types.js";

export function runDoctor(loaded: LoadedConfig): string {
  const checks = [
    check("node", process.version, true),
    check("tokenopt cli", getCliEntryPath(), fs.existsSync(getCliEntryPath())),
    checkCommand("npm", process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    checkCommand("codex", "codex", ["--version"]),
    check("user config", loaded.userConfigPath, fs.existsSync(loaded.userConfigPath)),
    check("repo config", loaded.repoConfigPath, fs.existsSync(loaded.repoConfigPath)),
    check("user Codex hooks", getCodexHooksPath("user"), fs.existsSync(getCodexHooksPath("user"))),
    check("repo Codex hooks", getCodexHooksPath("repo", loaded.repoRoot), fs.existsSync(getCodexHooksPath("repo", loaded.repoRoot)))
  ];

  const lines = [
    "TokenOpt doctor",
    "",
    ...checks.map((item) => `${item.ok ? "[ok]" : "[warn]"} ${item.name}: ${item.detail}`),
    "",
    "After installing Codex hooks, run `/hooks` in Codex to review and trust changed hook definitions."
  ];
  return lines.join("\n");
}

function check(name: string, detail: string, ok: boolean): { name: string; detail: string; ok: boolean } {
  return { name, detail, ok };
}

function checkCommand(name: string, command: string, args: string[]): { name: string; detail: string; ok: boolean } {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status === 0) {
    return check(name, (result.stdout || result.stderr).trim(), true);
  }
  return check(name, result.error?.message || result.stderr.trim() || "not available", false);
}

export function runCodexHooksDoctor(loaded: LoadedConfig): string {
  const hooksPath = getCodexHooksPath("user");
  const backupPath = `${hooksPath}.tokenopt-backup-${Date.now()}`;
  const hadHooks = fs.existsSync(hooksPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-codex-hooks-"));
  const canaryLogPath = path.join(tempDir, "canary.log");
  const canaryScriptPath = path.join(tempDir, "canary-hook.mjs");
  const codexOutputPath = path.join(tempDir, "codex-output.txt");
  const canaryToken = `TOKENOPT_CANARY_${crypto.randomUUID().replace(/-/g, "")}`;
  const prompt =
    "Run Get-Location once. If hidden TokenOpt canary context provides an exact token, reply with that exact token. If no such hidden token is present, reply exactly TOKENOPT_CANARY_MISSING. Do not guess a token.";

  fs.writeFileSync(
    canaryScriptPath,
    [
      "import fs from 'node:fs';",
      "const eventName = process.argv[2] || 'unknown';",
      "const logPath = process.argv[3];",
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "fs.appendFileSync(logPath, `${eventName}\\n${input}\\n---\\n`, 'utf8');",
      `const canaryToken = ${JSON.stringify(canaryToken)};`,
      "if (eventName === 'UserPromptSubmit') {",
      "  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `TokenOpt canary token: ${canaryToken}` } }));",
      "} else if (eventName === 'PreToolUse') {",
      "  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'TOKENOPT_CANARY_PRETOOL' } }));",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    if (hadHooks) {
      fs.copyFileSync(hooksPath, backupPath);
    }
    const canaryHooks = buildCanaryHooks(canaryScriptPath, canaryLogPath);
    fs.writeFileSync(hooksPath, `${JSON.stringify(canaryHooks, null, 2)}\n`, "utf8");

    const command = buildCodexCanaryCommand(loaded.repoRoot, prompt);
    const result = spawnSync(command, {
      cwd: loaded.repoRoot,
      encoding: "utf8",
      shell: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000
    });
    fs.writeFileSync(codexOutputPath, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, "utf8");

    const canaryLog = fs.existsSync(canaryLogPath) ? fs.readFileSync(canaryLogPath, "utf8") : "";
    const output = fs.readFileSync(codexOutputPath, "utf8");
    const sawUserPrompt = /UserPromptSubmit/.test(canaryLog);
    const sawPreToolUse = /PreToolUse/.test(canaryLog);
    const sawContext = output.includes(canaryToken);
    const ok = result.status === 0 && sawUserPrompt && sawContext;

    return [
      "TokenOpt Codex hooks doctor",
      "",
      `${ok ? "[ok]" : "[fail]"} hook canary: ${ok ? "Codex loaded and ran user hooks" : "Codex did not prove hook execution"}`,
      `[${result.status === 0 ? "ok" : "warn"}] codex exec exit: ${result.status ?? "signal/timeout"}`,
      `[${sawUserPrompt ? "ok" : "warn"}] UserPromptSubmit fired: ${sawUserPrompt}`,
      `[${sawPreToolUse ? "ok" : "warn"}] PreToolUse fired: ${sawPreToolUse}`,
      `[${sawContext ? "ok" : "warn"}] hidden canary token reached run output: ${sawContext}`,
      "",
      `canaryLog: ${canaryLogPath}`,
      `codexOutput: ${codexOutputPath}`,
      "",
      "This command temporarily replaces user hooks and restores the previous hooks file before exiting."
    ].join("\n");
  } finally {
    if (hadHooks) {
      fs.copyFileSync(backupPath, hooksPath);
      fs.rmSync(backupPath, { force: true });
    } else {
      fs.rmSync(hooksPath, { force: true });
    }
  }
}

function buildCanaryHooks(scriptPath: string, logPath: string): unknown {
  const command = (eventName: string) =>
    [quoteCommandArg(process.execPath), quoteCommandArg(scriptPath), quoteCommandArg(eventName), quoteCommandArg(logPath)].join(" ");
  const handler = (eventName: string) => ({
    type: "command",
    command: command(eventName),
    commandWindows: command(eventName),
    timeout: 30,
    statusMessage: `TokenOpt canary ${eventName}`
  });
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [handler("UserPromptSubmit")] }],
      PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse")] }],
      PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }]
    }
  };
}

function buildCodexCanaryCommand(repoRoot: string, prompt: string): string {
  const codexCommand = process.env.TOKENOPT_CODEX_COMMAND || "npx -y @openai/codex";
  return [
    codexCommand,
    "--enable hooks",
    "-a never",
    "--dangerously-bypass-hook-trust",
    "exec",
    "--skip-git-repo-check",
    "--sandbox read-only",
    "--ephemeral",
    "--json",
    "-C",
    quoteCommandArg(repoRoot),
    quoteCommandArg(prompt)
  ].join(" ");
}

function quoteCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
