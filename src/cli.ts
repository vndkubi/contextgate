#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runBenchmarkCommand } from "./benchmark.js";
import { runCodexBenchmarkCommand } from "./codex-benchmark.js";
import { runSuiteBenchmarkCommand } from "./suite-benchmark.js";
import { loadConfig, makeDefaultRepoConfig, ensureConfigDir } from "./config.js";
import { handleCodexHook } from "./codex-adapter.js";
import { runCodexHooksDoctor, runDoctor } from "./doctor.js";
import { runWrappedCommand } from "./exec.js";
import { installCodexHooks } from "./install.js";
import {
  auditInstructions,
  emitTokenOptInstructions,
  installTokenOptInstructions,
  type InstructionTarget
} from "./instruction-audit.js";
import { runMcpServer } from "./mcp.js";
import { appendEvent } from "./observability.js";
import { buildReport } from "./report.js";
import type { TokenOptHookEventName } from "./types.js";

const HOOK_EVENTS = new Set<TokenOptHookEventName>(["user-prompt-submit", "pre-tool-use", "post-tool-use", "pre-compact"]);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "init") {
    const loaded = loadConfig();
    ensureConfigDir(loaded.repoConfigPath);
    if (fs.existsSync(loaded.repoConfigPath)) {
      process.stdout.write(`TokenOpt config already exists: ${loaded.repoConfigPath}\n`);
      return 0;
    }
    fs.writeFileSync(loaded.repoConfigPath, `${JSON.stringify(makeDefaultRepoConfig(), null, 2)}\n`, "utf8");
    process.stdout.write(`Created ${loaded.repoConfigPath}\n`);
    return 0;
  }

  if (command === "install" && subcommand === "codex") {
    const scope = parseScope(rest);
    const loaded = loadConfig();
    const hooksPath = installCodexHooks(scope, scope === "repo" ? loaded.repoRoot : process.cwd());
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "install-codex",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: { scope, hooksPath }
    });
    process.stdout.write(`Installed TokenOpt Codex hooks: ${hooksPath}\nRun /hooks in Codex to review and trust them.\n`);
    return 0;
  }

  if (command === "hook" && subcommand === "codex") {
    const eventName = rest[0] as TokenOptHookEventName | undefined;
    if (!eventName || !HOOK_EVENTS.has(eventName)) {
      process.stderr.write("Usage: tokenopt hook codex user-prompt-submit|pre-tool-use|post-tool-use|pre-compact\n");
      return 2;
    }
    await handleCodexHook(eventName);
    return 0;
  }

  if (command === "exec") {
    const separatorIndex = argv.indexOf("--");
    const commandArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : argv.slice(1);
    const loaded = loadConfig();
    return runWrappedCommand(commandArgs, loaded.config, loaded.repoRoot);
  }

  if (command === "mcp") {
    await runMcpServer();
    return 0;
  }

  if (command === "benchmark") {
    if (subcommand === "suite") {
      return runSuiteBenchmarkCommand(rest);
    }
    if (subcommand === "codex-daily") {
      return runCodexBenchmarkCommand(rest);
    }
    return runBenchmarkCommand([subcommand, ...rest].filter((value): value is string => Boolean(value)));
  }

  if (command === "instructions" && subcommand === "audit") {
    const loaded = loadConfig();
    const report = auditInstructions(loaded.repoRoot);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "instructions-audit",
      repoRoot: loaded.repoRoot,
      action: "audit"
    });
    process.stdout.write(`${report}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "emit") {
    const target = parseInstructionTarget(rest, "generic");
    process.stdout.write(`${emitTokenOptInstructions(target)}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "install") {
    const target = parseInstructionTarget(rest, "agents");
    if (target === "generic") {
      process.stderr.write("Usage: tokenopt instructions install --target agents|codex|copilot\n");
      return 2;
    }
    const loaded = loadConfig();
    const filePath = installTokenOptInstructions(loaded.repoRoot, target);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "instructions-install",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: { target, filePath }
    });
    process.stdout.write(`Installed TokenOpt MCP instructions: ${filePath}\n`);
    return 0;
  }

  if (command === "report") {
    const loaded = loadConfig();
    process.stdout.write(`${buildReport(loaded.config, loaded.repoRoot)}\n`);
    return 0;
  }

  if (command === "doctor" && subcommand === "codex-hooks") {
    const loaded = loadConfig();
    const output = runCodexHooksDoctor(loaded);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "doctor-codex-hooks",
      repoRoot: loaded.repoRoot,
      action: "doctor"
    });
    process.stdout.write(`${output}\n`);
    return output.includes("[ok] hook canary") ? 0 : 1;
  }

  if (command === "doctor") {
    const loaded = loadConfig();
    const output = runDoctor(loaded);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "doctor",
      repoRoot: loaded.repoRoot,
      action: "doctor"
    });
    process.stdout.write(`${output}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${argv.join(" ")}\n\n${helpText()}`);
  return 2;
}

function parseScope(args: string[]): "user" | "repo" {
  const scopeIndex = args.indexOf("--scope");
  if (scopeIndex >= 0) {
    const value = args[scopeIndex + 1];
    if (value === "user" || value === "repo") {
      return value;
    }
    throw new Error("--scope must be user or repo");
  }
  return "repo";
}

function parseInstructionTarget(args: string[], fallback: InstructionTarget): InstructionTarget {
  const targetIndex = args.indexOf("--target");
  const value = targetIndex >= 0 ? args[targetIndex + 1] : fallback;
  if (value === "agents" || value === "codex" || value === "copilot" || value === "generic") {
    return value;
  }
  throw new Error("--target must be agents, codex, copilot, or generic");
}

function helpText(): string {
  return `TokenOpt CLI

Commands:
  tokenopt init
  tokenopt install codex --scope user|repo
  tokenopt hook codex user-prompt-submit|pre-tool-use|post-tool-use|pre-compact
  tokenopt exec -- <command...>
  tokenopt mcp
  tokenopt benchmark daily --repo <path> [--mode all]
  tokenopt benchmark codex-daily --repo <path> [--mode all]
  tokenopt benchmark suite --suite <json> --repo <path> [--mode baseline,mcp-first|router-best]
  tokenopt instructions audit
  tokenopt instructions emit --target agents|codex|copilot
  tokenopt instructions install --target agents|codex|copilot
  tokenopt report
  tokenopt doctor
  tokenopt doctor codex-hooks
`;
}

if (isDirectInvocation()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
