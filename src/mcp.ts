import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { readActiveEvidenceTaskState, writeEvidenceTaskState } from "./evidence-state.js";
import { executeWrappedShellCommand } from "./exec.js";
import { appendEvent, writeArtifact } from "./observability.js";
import { evaluatePolicy } from "./policy-core.js";
import { quoteShellArg } from "./shell.js";
import type {
  EvidenceCoverageStatus,
  EvidenceItem,
  EvidencePacket,
  EvidenceTaskType,
  LoadedConfig,
  PolicyDecision,
  TokenOptConfig,
  TokenOptEvent
} from "./types.js";

const SERVER_INSTRUCTIONS =
  "TokenOpt provides bounded repo tools and an evidence compiler. Start with tokenopt_compile_evidence for onboarding/build-handoff tasks. If it returns answerable=true, answer from the packet instead of replaying searches. Use tokenopt_search/read_file only for exact gaps and tokenopt_run_command for tests/builds so raw output is archived and model-visible output stays compact.";

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "tokenopt",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "tokenopt_compile_evidence",
        title: "Compile Answerability Evidence",
        description:
          "Build a compact evidence packet for a task and decide whether more tool calls are justified.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The user task to answer or plan." },
            task_type: {
              type: "string",
              enum: [
                "api_flow",
                "field_impact",
                "review_diff",
                "startup_flow",
                "investigate",
                "research_business",
                "implement",
                "write_unittest",
                "build_handoff",
                "unknown"
              ],
              description: "Optional task category. Defaults to deterministic inference."
            },
            budget_tokens: {
              type: "number",
              description: "Approximate max tokens for the evidence packet. Defaults to 1600."
            },
            quality_rubric: {
              type: "array",
              items: { type: "string" },
              description: "Optional checklist the packet must cover."
            },
            cwd: { type: "string", description: "Optional working directory. Defaults to the MCP server cwd." }
          },
          required: ["task"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt compile evidence",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_run_command",
        title: "Run Command Through TokenOpt",
        description:
          "Run a shell command through TokenOpt policy and output compression. Raw output is stored as an artifact.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run." },
            cwd: { type: "string", description: "Optional working directory. Defaults to the MCP server cwd." }
          },
          required: ["command"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt run command",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true
        }
      },
      {
        name: "tokenopt_search",
        title: "Search Repository Through TokenOpt",
        description: "Run a targeted ripgrep search with TokenOpt output compression.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Non-empty search pattern. Broad '.' searches are denied." },
            path: { type: "string", description: "Optional repo-relative path to search. Defaults to '.'." },
            cwd: { type: "string", description: "Optional working directory. Defaults to the MCP server cwd." }
          },
          required: ["pattern"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt search",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_read_file",
        title: "Read Bounded File Slice",
        description: "Read a bounded slice of a source file. Lockfiles and generated outputs are denied by policy.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repo-relative file path." },
            startLine: { type: "number", description: "1-based start line. Defaults to 1." },
            maxLines: { type: "number", description: "Maximum lines to return. Defaults to 200, capped at 400." },
            cwd: { type: "string", description: "Optional working directory. Defaults to the MCP server cwd." }
          },
          required: ["path"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt read file",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_project_facts",
        title: "Extract Project Build Facts",
        description:
          "Return deterministic build-system facts from common repo files, plus compact repo inventory. Use this for daily onboarding/build handoff tasks.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string", description: "Optional working directory. Defaults to the MCP server cwd." }
          },
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt project facts",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    try {
      switch (request.params.name) {
        case "tokenopt_compile_evidence":
          return compileEvidenceTool(args);
        case "tokenopt_run_command":
          return await runCommandTool(args);
        case "tokenopt_search":
          return await searchTool(args);
        case "tokenopt_read_file":
          return readFileTool(args);
        case "tokenopt_project_facts":
          return projectFactsTool(args);
        default:
          return textResult(`Unknown TokenOpt tool: ${request.params.name}`, true);
      }
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  await server.connect(new StdioServerTransport());
}

function compileEvidenceTool(args: Record<string, unknown>) {
  const task = requiredString(args, "task").trim();
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const taskType = normalizeTaskType(optionalString(args, "task_type"), task);
  const budgetTokens = clampInteger(optionalNumber(args, "budget_tokens") ?? 1600, 400, 8000);
  const qualityRubric = optionalStringArray(args, "quality_rubric").slice(0, 12);
  const inventory = buildRepoInventory(loaded.repoRoot, loaded.config, loaded.repoRoot);
  const facts = extractProjectFacts(loaded.repoRoot);
  const factFiles = factSourceFiles(facts);
  const hasBuildFacts = facts.some((fact) => fact.startsWith("build_tool="));
  const overview = extractRepositoryOverview(loaded.repoRoot);
  const structureFacts = extractStructureFacts(inventory);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const evidence: EvidenceItem[] = [
    {
      id: "E1",
      claim: "Repository build facts were extracted deterministically from common root build files.",
      files: factFiles,
      facts: facts.slice(0, 28),
      tokens_est: estimateTokens(facts.join("\n"))
    },
    {
      id: "E2",
      claim: "Repository shape was summarized from a raw file inventory stored outside model context.",
      facts: [
        `total_files=${inventory.totalFiles}`,
        `top_dirs=${inventory.topDirs.slice(0, 8).map(([name, count]) => `${name}:${count}`).join(",")}`,
        `top_extensions=${inventory.topExtensions.slice(0, 8).map(([name, count]) => `${name}:${count}`).join(",")}`,
        `raw_inventory_artifact=${inventory.rawArtifact}`
      ],
      tokens_est: 140
    }
  ];

  if (overview) {
    evidence.push({
      id: "E3",
      claim: "Repository overview was extracted from a root documentation file.",
      files: [overview.file],
      facts: [
        `overview_file=${overview.file}`,
        `overview_title=${overview.title}`,
        `overview_summary=${overview.summary}`
      ],
      tokens_est: estimateTokens(`${overview.title}\n${overview.summary}`)
    });
  }

  evidence.push({
    id: "E4",
    claim: "Likely source and test areas were inferred from bounded inventory counts.",
    facts: structureFacts,
    tokens_est: estimateTokens(structureFacts.join("\n"))
  });

  const answerable = isEvidenceAnswerable(taskType, hasBuildFacts, inventory.totalFiles > 0, Boolean(overview), structureFacts);
  const coverage = buildCoverage(taskType, hasBuildFacts, inventory.totalFiles > 0, Boolean(overview), structureFacts, qualityRubric);
  const missing = answerable
    ? []
    : [
        "Task is not answerable from deterministic project facts alone.",
        "Use exact search/read followups for the specific symbol, file, or command named by the task."
      ];
  const packet: EvidencePacket = {
    packet_id: crypto.randomUUID(),
    task,
    task_type: taskType,
    repo_root: loaded.repoRoot,
    answerable,
    confidence: answerable ? 0.86 : 0.48,
    coverage,
    evidence,
    missing,
    allowed_followups: answerable
      ? []
      : [
          {
            tool: "tokenopt_search",
            reason: "Search only for the concrete symbol, route, class, or config key required by the task.",
            args: { pattern: "<exact-pattern>", path: "<narrow-path>" },
            max_output_tokens: 600
          },
          {
            tool: "tokenopt_read_file",
            reason: "Read only bounded slices around exact matches.",
            args: { path: "<matched-file>", startLine: 1, maxLines: 120 },
            max_output_tokens: 900
          }
        ],
    disallowed_followups: answerable
      ? ["tokenopt_search", "tokenopt_read_file", "tokenopt_project_facts", "tokenopt_run_command", "shell_rg"]
      : ["repo_wide_rg_files", "full_file_reads", "full_suite_tests_without_target"],
    recommended_next_action: answerable ? "answer_now" : "expand_exact",
    max_additional_calls: answerable ? 0 : 3,
    token_budget: {
      budget_tokens: budgetTokens,
      evidence_tokens_est: evidence.reduce((total, item) => total + (item.tokens_est ?? estimateTokens(JSON.stringify(item))), 0),
      response_tokens_est: answerable ? Math.min(900, Math.max(300, Math.floor(budgetTokens * 0.45))) : 250
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  const statePath = answerable ? writeEvidenceTaskState(loaded.config, loaded.repoRoot, packet) : undefined;
  appendEvent(loaded.config, {
    timestamp: now.toISOString(),
    source: "cli",
    eventName: "compile-evidence",
    repoRoot: loaded.repoRoot,
    action: "evidence",
    reason: answerable ? "answerable" : "needs-exact-followup",
    metadata: {
      packetId: packet.packet_id,
      taskType,
      statePath,
      evidenceTokens: packet.token_budget.evidence_tokens_est
    }
  });

  return textResult(formatEvidencePacket(packet, statePath), false, {
    packet,
    statePath
  });
}

async function runCommandTool(args: Record<string, unknown>) {
  const command = requiredString(args, "command");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_run_command");
  if (gate) {
    return gate;
  }

  const decision = evaluateToolPolicy(cwd, "Bash", { command }, loaded.repoRoot);
  if (decision.action === "deny") {
    const replacement = maybeBuildCommandReplacement(command, cwd, loaded.config, loaded.repoRoot, decision.reason);
    if (replacement) {
      return textResult(replacement.text, false, replacement.structuredContent);
    }
    return textResult(`TokenOpt denied command before execution: ${decision.reason ?? "Policy denied command."}`, true);
  }

  const result = await executeWrappedShellCommand(command, loaded.config, loaded.repoRoot, cwd);
  const context = decision.action === "context" && decision.additionalContext ? `${decision.additionalContext}\n\n` : "";
  return textResult(`${context}${result.summary}`, false, {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawArtifact: result.rawArtifact,
    estimatedTokensSaved: result.estimatedTokensSaved
  });
}

function maybeBuildCommandReplacement(
  command: string,
  cwd: string,
  config: TokenOptConfig,
  repoRoot: string,
  reason?: string
): { text: string; structuredContent: Record<string, unknown> } | undefined {
  if (!isRepoWideFileListing(command)) {
    return undefined;
  }

  const inventory = buildRepoInventory(cwd, config, repoRoot);
  const text = [
    "TokenOpt replaced a raw repo-wide file listing with bounded repo inventory.",
    `originalCommand: ${command}`,
    `policyReason: ${reason ?? "Repo-wide file listing would produce high-token raw output."}`,
    `totalFiles: ${inventory.totalFiles}`,
    `rawChars: ${inventory.rawChars}`,
    `estimatedTokensAvoided: ${inventory.estimatedTokensAvoided}`,
    `rawArtifact: ${inventory.rawArtifact}`,
    "",
    "Top directories:",
    ...inventory.topDirs.map(([name, count]) => `- ${name}: ${count}`),
    "",
    "Top extensions:",
    ...inventory.topExtensions.map(([name, count]) => `- ${name}: ${count}`),
    "",
    "Root files:",
    ...inventory.rootFiles.map((file) => `- ${file}`),
    "",
    "Likely entry/config files:",
    ...inventory.importantFiles.map((file) => `- ${file}`),
    "",
    "Next step: use tokenopt_search with a concrete pattern or tokenopt_read_file for bounded file slices."
  ].join("\n");

  return {
    text,
    structuredContent: {
      action: "replaced",
      originalCommand: command,
      totalFiles: inventory.totalFiles,
      rawChars: inventory.rawChars,
      rawArtifact: inventory.rawArtifact,
      estimatedTokensAvoided: inventory.estimatedTokensAvoided
    }
  };
}

function isRepoWideFileListing(command: string): boolean {
  return /^rg\s+--files\b/i.test(command.trim());
}

function buildRepoInventory(cwd: string, config: TokenOptConfig, repoRoot: string): {
  totalFiles: number;
  rawChars: number;
  rawArtifact: string;
  estimatedTokensAvoided: number;
  topDirs: Array<[string, number]>;
  topExtensions: Array<[string, number]>;
  rootFiles: string[];
  importantFiles: string[];
} {
  const result = spawnSync("rg", ["--files"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const raw = stdout || stderr || `(rg --files exited with ${result.status ?? "unknown"} and no output)`;
  const files = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rawArtifact = writeArtifact(config, repoRoot, "repo-files.txt", raw);
  const topDirs = topCounts(files.map(firstPathSegment), 12);
  const topExtensions = topCounts(files.map(fileExtension), 12);
  const rootFiles = files.filter((file) => !/[\\/]/.test(file)).slice(0, 30);
  const importantFiles = files.filter(isImportantFile).slice(0, 60);
  const summaryChars = 2500 + rootFiles.join("\n").length + importantFiles.join("\n").length;

  return {
    totalFiles: files.length,
    rawChars: raw.length,
    rawArtifact,
    estimatedTokensAvoided: Math.ceil(Math.max(0, raw.length - summaryChars) / 4),
    topDirs,
    topExtensions,
    rootFiles,
    importantFiles
  };
}

function firstPathSegment(filePath: string): string {
  const segment = filePath.split(/[\\/]/, 1)[0] || ".";
  return segment === filePath && !/[\\/]/.test(filePath) ? "<root>" : segment;
}

function fileExtension(filePath: string): string {
  const base = path.basename(filePath);
  if (/^README(?:\..*)?$/i.test(base)) {
    return "README";
  }
  const extension = path.extname(base).toLowerCase();
  return extension || "<none>";
}

function topCounts(values: string[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function isImportantFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  if (/^(readme|package|pom|build\.gradle|settings\.gradle|gradle\.properties|tsconfig|eslint|vite|webpack|cargo|go\.mod|pyproject|requirements)/i.test(base)) {
    return true;
  }
  return /(^|\/)(src|server|client|app|lib|core|modules|docs)\//i.test(normalized) && /\.(ts|tsx|js|jsx|java|py|go|rs|md|asciidoc)$/i.test(base);
}

async function searchTool(args: Record<string, unknown>) {
  const pattern = requiredString(args, "pattern").trim();
  if (!pattern || pattern === "." || pattern === ".*") {
    return textResult("TokenOpt denied broad search. Provide a concrete pattern.", true);
  }

  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const searchPath = optionalString(args, "path") ?? ".";
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_search");
  if (gate) {
    return gate;
  }

  const targetPath = resolveRepoPath(loaded.repoRoot, searchPath);
  if (!targetPath.ok) {
    return textResult(targetPath.error, true);
  }

  const command = [
    "rg",
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    quoteShellArg(pattern),
    quoteShellArg(path.relative(cwd, targetPath.path) || ".")
  ].join(" ");
  const result = await executeWrappedShellCommand(command, loaded.config, loaded.repoRoot, cwd);
  return textResult(result.summary, false, {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawArtifact: result.rawArtifact,
    estimatedTokensSaved: result.estimatedTokensSaved
  });
}

function readFileTool(args: Record<string, unknown>) {
  const requestedPath = requiredString(args, "path");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_read_file");
  if (gate) {
    return gate;
  }

  const targetPath = resolveRepoPath(loaded.repoRoot, requestedPath);
  if (!targetPath.ok) {
    return textResult(targetPath.error, true);
  }

  const decision = evaluateToolPolicy(cwd, "mcp__tokenopt__read_file", { path: requestedPath }, loaded.repoRoot);
  if (decision.action === "deny" && !decision.reason?.startsWith("Full-file read is blocked")) {
    return textResult(`TokenOpt denied file read: ${decision.reason ?? "Policy denied read."}`, true);
  }

  const stat = fs.statSync(targetPath.path);
  if (!stat.isFile()) {
    return textResult(`TokenOpt denied file read: not a file: ${requestedPath}`, true);
  }

  const startLine = clampInteger(optionalNumber(args, "startLine") ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const maxLines = clampInteger(optionalNumber(args, "maxLines") ?? 200, 1, 400);
  const allLines = fs.readFileSync(targetPath.path, "utf8").replace(/\r\n/g, "\n").split("\n");
  const selected = allLines.slice(startLine - 1, startLine - 1 + maxLines);
  const relative = path.relative(loaded.repoRoot, targetPath.path);
  const endLine = selected.length === 0 ? startLine : startLine + selected.length - 1;

  return textResult(
    [
      `TokenOpt bounded file read`,
      `file: ${relative}`,
      `lines: ${startLine}-${endLine} of ${allLines.length}`,
      "",
      selected.map((line, index) => `${startLine + index}: ${line}`).join("\n")
    ].join("\n"),
    false,
    {
      file: relative,
      startLine,
      endLine,
      totalLines: allLines.length
    }
  );
}

function projectFactsTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_project_facts");
  if (gate) {
    return gate;
  }

  const inventory = buildRepoInventory(loaded.repoRoot, loaded.config, loaded.repoRoot);
  const facts = extractProjectFacts(loaded.repoRoot);

  const text = [
    "TokenOpt project facts",
    `repoRoot: ${loaded.repoRoot}`,
    `totalFiles: ${inventory.totalFiles}`,
    `rawInventoryChars: ${inventory.rawChars}`,
    `rawInventoryArtifact: ${inventory.rawArtifact}`,
    "",
    "Build facts:",
    ...facts.map((fact) => `- ${fact}`),
    "",
    "Top directories:",
    ...inventory.topDirs.slice(0, 8).map(([name, count]) => `- ${name}: ${count}`),
    "",
    "Root files:",
    ...inventory.rootFiles.slice(0, 20).map((file) => `- ${file}`)
  ].join("\n");

  return textResult(text, false, {
    repoRoot: loaded.repoRoot,
    totalFiles: inventory.totalFiles,
    rawInventoryArtifact: inventory.rawArtifact,
    facts
  });
}

function maybeGateAfterAnswerable(loaded: LoadedConfig, attemptedTool: string) {
  const state = readActiveEvidenceTaskState(loaded.config, loaded.repoRoot);
  if (!state || state.packet.max_additional_calls > 0) {
    return undefined;
  }

  const packet = state.packet;
  const text = [
    "TokenOpt answerability gate: do not replay evidence.",
    `attemptedTool: ${attemptedTool}`,
    `packet_id: ${packet.packet_id}`,
    `task_type: ${packet.task_type}`,
    `confidence: ${packet.confidence}`,
    `expires_at: ${packet.expires_at}`,
    "",
    "Use the compiled evidence packet already in context and answer now.",
    "If the user changes the task, call tokenopt_compile_evidence for the new task."
  ].join("\n");

  return textResult(text, false, {
    action: "answerability_gate",
    attemptedTool,
    packetId: packet.packet_id,
    recommendedNextAction: packet.recommended_next_action,
    expiresAt: packet.expires_at
  });
}

function normalizeTaskType(value: string | undefined, task: string): EvidenceTaskType {
  const known = new Set<EvidenceTaskType>([
    "api_flow",
    "field_impact",
    "review_diff",
    "startup_flow",
    "investigate",
    "research_business",
    "implement",
    "write_unittest",
    "build_handoff",
    "unknown"
  ]);
  if (value && known.has(value as EvidenceTaskType)) {
    return value as EvidenceTaskType;
  }
  return inferTaskType(task);
}

function inferTaskType(task: string): EvidenceTaskType {
  if (/\b(unit test|unittest|write test|add test|test plan|test strategy)\b/i.test(task)) {
    return "write_unittest";
  }
  if (/\b(implement|change|add feature|modify|patch|code change)\b/i.test(task)) {
    return "implement";
  }
  if (/\b(business|product|domain|customer|research|purpose|what does this repo do)\b/i.test(task)) {
    return "research_business";
  }
  if (/\b(investigate|debug|diagnose|root cause|why|triage)\b/i.test(task)) {
    return "investigate";
  }
  if (/\b(build|test|compile|gradle|maven|npm|package|version|wrapper|onboard|handoff|daily task)\b/i.test(task)) {
    return "build_handoff";
  }
  if (/\b(api|endpoint|route|request|response|controller)\b/i.test(task)) {
    return "api_flow";
  }
  if (/\b(field|column|property|schema|impact)\b/i.test(task)) {
    return "field_impact";
  }
  if (/\b(diff|review|pull request|pr)\b/i.test(task)) {
    return "review_diff";
  }
  if (/\b(startup|boot|initialize|server start)\b/i.test(task)) {
    return "startup_flow";
  }
  return "unknown";
}

function buildCoverage(
  taskType: EvidenceTaskType,
  hasBuildFacts: boolean,
  hasInventory: boolean,
  hasOverview: boolean,
  structureFacts: string[],
  qualityRubric: string[]
): Record<string, EvidenceCoverageStatus> {
  const coverage: Record<string, EvidenceCoverageStatus> = {
    repo_shape: hasInventory ? "covered" : "missing"
  };
  const hasSourceAreas = structureFacts.some((fact) => fact.startsWith("source_dirs="));
  const hasTestAreas = structureFacts.some((fact) => fact.startsWith("test_dirs="));

  switch (taskType) {
    case "build_handoff":
      coverage.build_system = hasBuildFacts ? "covered" : "missing";
      coverage.build_files = hasBuildFacts ? "covered" : "missing";
      coverage.handoff_answer = hasBuildFacts ? "covered" : "partial";
      break;
    case "investigate":
      coverage.investigation_scope = hasInventory ? "covered" : "missing";
      coverage.build_context = hasBuildFacts ? "covered" : "partial";
      coverage.exact_next_commands = hasBuildFacts ? "covered" : "partial";
      break;
    case "research_business":
      coverage.repository_purpose = hasOverview ? "covered" : "partial";
      coverage.project_identity = hasBuildFacts || hasOverview ? "covered" : "missing";
      coverage.major_areas = hasInventory ? "covered" : "missing";
      break;
    case "implement":
      coverage.implementation_scope = hasSourceAreas ? "covered" : "partial";
      coverage.files_to_inspect = hasInventory ? "covered" : "missing";
      coverage.test_strategy = hasBuildFacts ? "covered" : "partial";
      break;
    case "write_unittest":
      coverage.test_locations = hasTestAreas ? "covered" : "partial";
      coverage.test_command = hasBuildFacts ? "covered" : "partial";
      coverage.build_context = hasBuildFacts ? "covered" : "missing";
      break;
    default:
      coverage.task_specific_code = "missing";
      coverage.followup_scope = "partial";
  }

  qualityRubric.forEach((item, index) => {
    coverage[`rubric_${index + 1}_${slugKey(item)}`] = isEvidenceAnswerable(taskType, hasBuildFacts, hasInventory, hasOverview, structureFacts)
      ? "covered"
      : "partial";
  });
  return coverage;
}

function isEvidenceAnswerable(
  taskType: EvidenceTaskType,
  hasBuildFacts: boolean,
  hasInventory: boolean,
  hasOverview: boolean,
  structureFacts: string[]
): boolean {
  const hasSourceAreas = structureFacts.some((fact) => fact.startsWith("source_dirs="));
  const hasTestAreas = structureFacts.some((fact) => fact.startsWith("test_dirs="));
  switch (taskType) {
    case "build_handoff":
      return hasBuildFacts;
    case "investigate":
      return hasBuildFacts && hasInventory;
    case "research_business":
      return hasInventory && (hasOverview || hasBuildFacts);
    case "implement":
      return hasInventory && hasBuildFacts && hasSourceAreas;
    case "write_unittest":
      return hasBuildFacts && hasInventory && (hasTestAreas || hasSourceAreas);
    default:
      return false;
  }
}

function factSourceFiles(facts: string[]): string[] {
  const files = new Set<string>();
  for (const fact of facts) {
    const [, value] = fact.split("=", 2);
    if (fact.includes("_file=") && value) {
      files.add(value);
    }
    if (fact.startsWith("build_tool=Npm")) {
      files.add("package.json");
    }
    if (fact.startsWith("npm_lock_file=") && value) {
      files.add(value);
    }
    if (fact.startsWith("maven_root_file=")) {
      files.add("pom.xml");
    }
  }
  return [...files].sort();
}

function formatEvidencePacket(packet: EvidencePacket, statePath: string | undefined): string {
  const lines = [
    "TokenOpt compiled evidence packet",
    `packet_id: ${packet.packet_id}`,
    `answerable: ${packet.answerable}`,
    `confidence: ${packet.confidence}`,
    `recommended_next_action: ${packet.recommended_next_action}`,
    `max_additional_calls: ${packet.max_additional_calls}`,
    statePath ? `state_path: ${statePath}` : undefined,
    "",
    "Coverage:",
    ...Object.entries(packet.coverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Evidence:",
    ...packet.evidence.flatMap((item) => [
      `- ${item.id}: ${item.claim}`,
      ...(item.files && item.files.length > 0 ? [`  files: ${item.files.join(", ")}`] : []),
      ...(item.facts ?? []).slice(0, 32).map((fact) => `  fact: ${fact}`)
    ]),
    "",
    "Missing:",
    ...(packet.missing.length > 0 ? packet.missing.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Allowed followups:",
    ...(packet.allowed_followups.length > 0
      ? packet.allowed_followups.map((followup) => `- ${followup.tool}: ${followup.reason}`)
      : ["- none"]),
    "",
    "Disallowed followups:",
    ...packet.disallowed_followups.map((followup) => `- ${followup}`)
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function slugKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function extractRepositoryOverview(repoRoot: string): { file: string; title: string; summary: string } | undefined {
  for (const candidate of ["README.md", "README.asciidoc", "README.adoc", "README"]) {
    const text = readRepoText(repoRoot, candidate);
    if (!text) {
      continue;
    }
    const lines = text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^(<!--|!\[|\[!)/.test(line));
    const title = cleanOverviewLine(lines.find((line) => /^#{1,2}\s+/.test(line) || /^=+\s+/.test(line)) ?? lines[0] ?? candidate);
    const summary = cleanOverviewLine(
      lines.find((line) => !/^#{1,6}\s+/.test(line) && !/^=+\s+/.test(line) && line.length >= 40) ?? lines.slice(1, 4).join(" ")
    );
    return {
      file: candidate,
      title: title.slice(0, 160),
      summary: summary.slice(0, 500)
    };
  }
  return undefined;
}

function cleanOverviewLine(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").replace(/^=+\s+/, "").replace(/\s+/g, " ").trim();
}

function extractStructureFacts(inventory: ReturnType<typeof buildRepoInventory>): string[] {
  const importantFiles = inventory.importantFiles.map((file) => file.replace(/\\/g, "/"));
  const sourceDirs = topCounts(
    importantFiles
      .filter((file) => /\.(ts|tsx|js|jsx|java|py|go|rs|kt|scala|c|cc|cpp|h|hpp)$/i.test(file))
      .map((file) => file.split("/").slice(0, 2).join("/") || "<root>"),
    10
  ).map(([name, count]) => `${name}:${count}`);
  const testDirs = topCounts(
    importantFiles
      .filter((file) => /(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(file))
      .map((file) => file.split("/").slice(0, 3).join("/") || "<root>"),
    10
  ).map(([name, count]) => `${name}:${count}`);
  const configFiles = importantFiles
    .filter((file) => /(^|\/)(package\.json|pom\.xml|build\.gradle|settings\.gradle|gradle\.properties|pyproject\.toml|go\.mod|Cargo\.toml|tsconfig\.json)$/i.test(file))
    .slice(0, 20);

  return [
    `source_dirs=${sourceDirs.length > 0 ? sourceDirs.join(",") : "none_detected"}`,
    `test_dirs=${testDirs.length > 0 ? testDirs.join(",") : "none_detected"}`,
    `config_files=${configFiles.length > 0 ? configFiles.join(",") : "none_detected"}`,
    `important_file_sample=${importantFiles.slice(0, 20).join(",") || "none_detected"}`
  ];
}

function extractProjectFacts(repoRoot: string): string[] {
  const facts: string[] = [];
  const gradleWrapper = readRepoText(repoRoot, "gradle/wrapper/gradle-wrapper.properties");
  if (gradleWrapper) {
    const url = matchFirst(gradleWrapper, /^distributionUrl=(.+)$/m);
    const version = url ? matchFirst(url, /gradle-([0-9][^-]+)-(?:all|bin)\.zip/) : undefined;
    facts.push(`build_tool=Gradle`);
    facts.push(`gradle_wrapper_file=gradle/wrapper/gradle-wrapper.properties`);
    if (version) {
      facts.push(`gradle_wrapper_version=${version}`);
    }
    if (url) {
      facts.push(`gradle_distribution_url=${url.replace(/\\:/g, ":")}`);
    }
  }

  const settingsGradle = readRepoText(repoRoot, "settings.gradle");
  if (settingsGradle) {
    const rootName = matchFirst(settingsGradle, /rootProject\.name\s*=\s*["']([^"']+)["']/);
    if (rootName) {
      facts.push(`gradle_root_project=${rootName}`);
    }
  }

  const elasticVersions = readRepoText(repoRoot, "build-tools-internal/version.properties");
  if (elasticVersions) {
    const elasticVersion = matchFirst(elasticVersions, /^elasticsearch\s*=\s*(.+)$/m);
    const luceneVersion = matchFirst(elasticVersions, /^lucene\s*=\s*(.+)$/m);
    if (elasticVersion) {
      facts.push(`elasticsearch_version=${elasticVersion.trim()}`);
    }
    if (luceneVersion) {
      facts.push(`lucene_version=${luceneVersion.trim()}`);
    }
  }

  const pom = readRepoText(repoRoot, "pom.xml");
  if (pom) {
    const projectBlock = pom.slice(0, Math.min(pom.length, 20_000));
    const groupId = matchFirst(projectBlock, /<groupId>([^<]+)<\/groupId>/);
    const artifactId = matchFirst(projectBlock, /<artifactId>([^<]+)<\/artifactId>/);
    const version = matchFirst(projectBlock, /<version>([^<]+)<\/version>/);
    const packaging = matchFirst(projectBlock, /<packaging>([^<]+)<\/packaging>/);
    const hadoopVersion = matchFirst(projectBlock, /<hadoop\.version>([^<]+)<\/hadoop\.version>/);
    facts.push(`build_tool=Maven`);
    facts.push(`maven_root_file=pom.xml`);
    if (groupId) {
      facts.push(`maven_group_id=${groupId}`);
    }
    if (artifactId) {
      facts.push(`maven_artifact_id=${artifactId}`);
    }
    if (version) {
      facts.push(`maven_project_version=${version}`);
    }
    if (packaging) {
      facts.push(`maven_packaging=${packaging}`);
    }
    if (hadoopVersion) {
      facts.push(`hadoop_version=${hadoopVersion}`);
    }
  }

  const mavenWrapper = readRepoText(repoRoot, ".mvn/wrapper/maven-wrapper.properties");
  if (mavenWrapper) {
    const wrapperVersion = matchFirst(mavenWrapper, /^wrapperVersion=(.+)$/m);
    const distributionUrl = matchFirst(mavenWrapper, /^distributionUrl=(.+)$/m);
    const mavenVersion = distributionUrl ? matchFirst(distributionUrl, /apache-maven\/([^/]+)\/apache-maven-\1-bin\.zip/) : undefined;
    facts.push(`maven_wrapper_file=.mvn/wrapper/maven-wrapper.properties`);
    if (wrapperVersion) {
      facts.push(`maven_wrapper_version=${wrapperVersion}`);
    }
    if (mavenVersion) {
      facts.push(`maven_distribution_version=${mavenVersion}`);
    }
    if (distributionUrl) {
      facts.push(`maven_distribution_url=${distributionUrl}`);
    }
  }

  const packageJson = readRepoText(repoRoot, "package.json");
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as {
        name?: unknown;
        version?: unknown;
        packageManager?: unknown;
        scripts?: unknown;
      };
      facts.push("build_tool=Npm");
      facts.push("npm_root_file=package.json");
      if (typeof parsed.name === "string") {
        facts.push(`npm_package_name=${parsed.name}`);
      }
      if (typeof parsed.version === "string") {
        facts.push(`npm_package_version=${parsed.version}`);
      }
      if (typeof parsed.packageManager === "string") {
        facts.push(`npm_package_manager=${parsed.packageManager}`);
      }
      if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
        facts.push(`npm_scripts=${Object.keys(parsed.scripts).sort().join(",")}`);
      }
      for (const lockFile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
        if (fs.existsSync(path.join(repoRoot, lockFile))) {
          facts.push(`npm_lock_file=${lockFile}`);
          break;
        }
      }
    } catch {
      facts.push("npm_root_file=package.json");
      facts.push("npm_package_json_parse_error=true");
    }
  }

  return facts.length > 0 ? facts : ["No common Gradle, Maven, or npm build facts detected."];
}

function readRepoText(repoRoot: string, relativePath: string): string | undefined {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return fs.readFileSync(filePath, "utf8");
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}

function evaluateToolPolicy(cwd: string, toolName: string, toolInput: unknown, repoRoot: string): PolicyDecision {
  const loaded = loadConfig({ cwd });
  const event: TokenOptEvent = {
    source: "codex",
    eventName: "pre-tool-use",
    cwd,
    toolName,
    toolInput,
    raw: {
      hook_event_name: "PreToolUse",
      cwd,
      tool_name: toolName,
      tool_input: toolInput
    }
  };
  return evaluatePolicy(event, loaded.config, { repoRoot });
}

function textResult(text: string, isError = false, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
    structuredContent
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function resolveRepoPath(repoRoot: string, requestedPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const absolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(repoRoot, requestedPath);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: `TokenOpt denied path outside repo: ${requestedPath}` };
  }
  if (!fs.existsSync(absolute)) {
    return { ok: false, error: `Path does not exist: ${requestedPath}` };
  }
  return { ok: true, path: absolute };
}
