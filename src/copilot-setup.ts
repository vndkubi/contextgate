import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNativePromptPack, installTokenOptInstructions } from "./instruction-audit.js";

export type CopilotSetupScope = "user" | "repo" | "both";

export const TOKENOPT_COPILOT_LITE_MCP_TOOLS = [
  "tokenopt_compile_evidence",
  "tokenopt_search",
  "tokenopt_read_file"
] as const;

export const TOKENOPT_COPILOT_MCP_TOOLS = [
  ...TOKENOPT_COPILOT_LITE_MCP_TOOLS,
  "tokenopt_run_command",
  "tokenopt_project_facts"
] as const;

export interface CopilotSetupOptions {
  repoRoot: string;
  scope?: CopilotSetupScope;
  installAgents?: boolean;
  tokenoptCliPath?: string;
  copilotConfigPath?: string;
  includeRunCommand?: boolean;
  installPrompts?: boolean;
}

export interface CopilotSetupResult {
  repoRoot: string;
  files: string[];
  warnings: string[];
  nextSteps: string[];
  mcpConfigPath?: string;
  copilotInstructionsPath: string;
  copilotPathInstructionsPath: string;
  agentsPath?: string;
  copilotAgentPath?: string;
  promptFiles: string[];
}

export function setupCopilotProject(options: CopilotSetupOptions): CopilotSetupResult {
  const repoRoot = path.resolve(options.repoRoot);
  const scope = options.scope ?? "both";
  const installAgents = options.installAgents ?? true;
  const installPrompts = options.installPrompts ?? true;
  const includeRunCommand = options.includeRunCommand ?? false;
  const files: string[] = [];
  const warnings: string[] = [];
  const nextSteps: string[] = [];

  const copilotInstructionsPath = installTokenOptInstructions(repoRoot, "copilot");
  files.push(copilotInstructionsPath);
  const copilotPathInstructionsPath = installTokenOptInstructions(repoRoot, "copilot-path");
  files.push(copilotPathInstructionsPath);

  let agentsPath: string | undefined;
  let copilotAgentPath: string | undefined;
  if (installAgents) {
    agentsPath = installTokenOptInstructions(repoRoot, "agents");
    files.push(agentsPath);
    copilotAgentPath = installTokenOptInstructions(repoRoot, "copilot-agent");
    files.push(copilotAgentPath);
  }

  const promptFiles = installPrompts ? installNativePromptPack(repoRoot) : [];
  files.push(...promptFiles);

  let mcpConfigPath: string | undefined;
  if (scope === "user" || scope === "both") {
    mcpConfigPath = installCopilotUserMcpConfig({
      configPath: options.copilotConfigPath,
      tokenoptCliPath: options.tokenoptCliPath,
      includeRunCommand
    });
    files.push(mcpConfigPath);
    nextSteps.push("Open Copilot CLI in the target repo and run /mcp show tokenopt.");
  }

  if (scope === "repo") {
    nextSteps.push("For local Copilot CLI, make sure tokenopt is already installed in user MCP config by running tokenopt setup copilot --scope user once.");
  }

  if (scope === "repo" || scope === "both") {
    nextSteps.push("For GitHub.com cloud agent/code review, paste a cloud-compatible MCP JSON into Repository -> Settings -> Copilot -> MCP servers.");
  }

  if (!installAgents) {
    warnings.push("AGENTS.md and the TokenOpt custom agent were skipped; Copilot can still use .github/copilot-instructions.md and .github/instructions/tokenopt.instructions.md, but agent surfaces may miss stronger TokenOpt guidance.");
  }
  if (!installPrompts) {
    warnings.push("Copilot prompt files were skipped; users can still rely on always-on instructions, but slash prompts such as /pbi-plan and /review-code will not be installed.");
  }
  if (!includeRunCommand) {
    warnings.push("TokenOpt MCP was installed in lite mode; command execution and project_facts tools are not exposed unless you rerun setup with --include-run-command.");
  }
  warnings.push("Copilot hooks were not installed. TokenOpt does not ship a Copilot hook adapter yet; use MCP + instructions for Copilot today.");

  return {
    repoRoot,
    files,
    warnings,
    nextSteps,
    mcpConfigPath,
    copilotInstructionsPath,
    copilotPathInstructionsPath,
    agentsPath,
    copilotAgentPath,
    promptFiles
  };
}

export function installCopilotUserMcpConfig(options: {
  configPath?: string;
  tokenoptCliPath?: string;
  includeRunCommand?: boolean;
} = {}): string {
  const configPath = options.configPath ?? getCopilotMcpConfigPath();
  const tokenoptCliPath = normalizeJsonPath(path.resolve(options.tokenoptCliPath ?? getDefaultTokenOptCliPath()));
  const includeRunCommand = options.includeRunCommand ?? false;
  const mode = includeRunCommand ? "full" : "lite";
  const tools = includeRunCommand ? [...TOKENOPT_COPILOT_MCP_TOOLS] : [...TOKENOPT_COPILOT_LITE_MCP_TOOLS];

  const config = readJsonObject(configPath);
  const mcpServers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  mcpServers.tokenopt = {
    type: "local",
    command: "node",
    args: [tokenoptCliPath, "mcp", "--mode", mode],
    env: {},
    tools
  };

  const next = {
    ...config,
    mcpServers
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configPath;
}

export function getCopilotMcpConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".copilot", "mcp-config.json");
}

export function getDefaultTokenOptCliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export function buildCopilotCloudMcpConfig(includeRunCommand = false): string {
  const mode = includeRunCommand ? "full" : "lite";
  const tools = includeRunCommand ? [...TOKENOPT_COPILOT_MCP_TOOLS] : [...TOKENOPT_COPILOT_LITE_MCP_TOOLS];
  return `${JSON.stringify({
    mcpServers: {
      tokenopt: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@tokenopt/cli", "mcp", "--mode", mode],
        tools
      }
    }
  }, null, 2)}\n`;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (text.length === 0) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Copilot MCP config must be a JSON object: ${filePath}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonPath(value: string): string {
  return value.replace(/\\/g, "/");
}
