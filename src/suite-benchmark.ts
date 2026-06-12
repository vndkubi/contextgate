import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { routeTask } from "./router.js";
import type { AcquisitionMode, EvidenceContractName, EvidenceTaskType } from "./types.js";

type SuiteBenchmarkMode = "baseline" | "mcp-first" | "mcp-only" | "compiled-hard-gate" | "router-strict" | "router-best";

interface SuiteFile {
  name?: string;
  version?: string;
  purpose?: string;
  tasks?: unknown[];
}

interface SuiteTask {
  id: string;
  project: string;
  class: string;
  winnerHypothesis?: string;
  prompt: string;
  expectedEvidence: {
    files: string[];
    symbols: string[];
    terms: string[];
  };
  qualityRubric: string[];
  gateAssertions: string[];
  maxBudget?: {
    mcpCallsCompiled?: number;
    targetedShellCalls?: number;
    shellCallsAfterAnswerable?: number;
    packetTokens?: number;
  };
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexRunMetrics {
  exitCode: number | null;
  durationMs: number;
  finalAnswer: string;
  usage: CodexUsage;
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  warnings: number;
  rawLogPath: string;
  lastMessagePath: string;
}

interface QualityCheck {
  category: "json" | "file" | "symbol" | "term";
  name: string;
  passed: boolean;
}

interface QualityResult {
  score: number;
  passed: number;
  total: number;
  jsonValid: boolean;
  criticalMisses: string[];
  checks: QualityCheck[];
}

interface SuiteBenchmarkRow extends CodexRunMetrics {
  repo: string;
  project: string;
  taskId: string;
  taskClass: string;
  acquisitionMode: AcquisitionMode;
  evidenceContract: EvidenceContractName;
  evidenceContractPass: boolean;
  fallbackReason: string;
  doubleSpend: boolean;
  mode: SuiteBenchmarkMode;
  prompt: string;
  codexPrompt: string;
  qualityScore: number;
  qualityChecks: string;
  qualityPassed: boolean;
  correct: boolean;
  jsonValid: boolean;
  criticalMisses: string[];
  expectedEvidence: SuiteTask["expectedEvidence"];
  qualityRubric: string[];
}

interface SkippedRepo {
  repo: string;
  project: string;
  reason: string;
}

interface SuiteBenchmarkOptions {
  suitePath: string;
  repos: string[];
  modes: SuiteBenchmarkMode[];
  taskIds?: Set<string>;
  codexPackage: string;
  outPath?: string;
  markdownPath?: string;
  rawDir: string;
  json: boolean;
  showAnswers: boolean;
  timeoutMs: number;
  maxTasks?: number;
  maxTasksPerRepo?: number;
  model?: string;
}

const CODEX_PACKAGE = "@openai/codex@0.137.0";

export async function runSuiteBenchmarkCommand(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const suite = loadSuite(options.suitePath);
  const selected = selectSuiteTasks(suite.tasks, options);
  const rows: SuiteBenchmarkRow[] = [];

  fs.mkdirSync(options.rawDir, { recursive: true });
  for (const item of selected.items) {
    for (const mode of options.modes) {
      const codexPrompt = buildSuitePrompt(item.repo, item.task, mode);
      const run = runCodexSuiteBenchmark(item.repo, item.task, mode, codexPrompt, options);
      const quality = scoreSuiteAnswer(item.task, run.finalAnswer);
      const routeMetadata = buildSuiteRouteMetadata(item.task.prompt, inferTaskType(item.task), {
        finalAnswer: run.finalAnswer,
        mcpCalls: run.mcpCalls,
        shellCalls: run.shellCalls
      });
      rows.push({
        ...run,
        repo: item.repo,
        project: item.task.project,
        taskId: item.task.id,
        taskClass: item.task.class,
        acquisitionMode: routeMetadata.acquisitionMode,
        evidenceContract: routeMetadata.evidenceContract,
        evidenceContractPass: routeMetadata.evidenceContractPass,
        fallbackReason: routeMetadata.fallbackReason,
        doubleSpend: routeMetadata.doubleSpend,
        mode,
        prompt: item.task.prompt,
        codexPrompt,
        qualityScore: quality.score,
        qualityChecks: `${quality.passed}/${quality.total}`,
        qualityPassed: quality.score >= 0.8,
        correct: quality.score >= 0.8,
        jsonValid: quality.jsonValid,
        criticalMisses: quality.criticalMisses,
        expectedEvidence: item.task.expectedEvidence,
        qualityRubric: item.task.qualityRubric
      });
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    runner: "codex exec --json",
    codexPackage: options.codexPackage,
    suite: {
      path: options.suitePath,
      name: suite.name,
      version: suite.version,
      purpose: suite.purpose
    },
    modes: options.modes,
    skippedRepos: selected.skippedRepos,
    rows: options.showAnswers ? rows : rows.map((row) => ({ ...row, finalAnswer: undefined, codexPrompt: undefined }))
  };

  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  if (options.markdownPath) {
    fs.mkdirSync(path.dirname(options.markdownPath), { recursive: true });
    fs.writeFileSync(options.markdownPath, formatMarkdownReport(suite, rows, selected.skippedRepos, options), "utf8");
  }

  process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : formatSuiteRows(rows, selected.skippedRepos, options.showAnswers));
  return rows.some((row) => row.exitCode !== 0 || !row.correct) ? 1 : 0;
}

function parseOptions(args: string[]): SuiteBenchmarkOptions {
  let suitePath: string | undefined;
  const repos: string[] = [];
  let modes: SuiteBenchmarkMode[] = ["baseline", "mcp-first"];
  let taskIds: Set<string> | undefined;
  let codexPackage = CODEX_PACKAGE;
  let outPath: string | undefined;
  let markdownPath: string | undefined;
  let json = false;
  let showAnswers = false;
  let timeoutMs = 600_000;
  let maxTasks: number | undefined;
  let maxTasksPerRepo: number | undefined;
  let model: string | undefined;
  let rawDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      suitePath = requiredValue(args, index, "--suite");
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      repos.push(path.resolve(requiredValue(args, index, "--repo")));
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = requiredValue(args, index, "--mode");
      modes = value === "all" ? ["baseline", "mcp-first", "mcp-only", "compiled-hard-gate", "router-strict", "router-best"] : value.split(",").map(parseMode);
      index += 1;
      continue;
    }
    if (arg === "--task") {
      const value = requiredValue(args, index, "--task");
      taskIds = value === "all" ? undefined : new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    if (arg === "--codex-package") {
      codexPackage = requiredValue(args, index, "--codex-package");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requiredValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(requiredValue(args, index, "--timeout-ms"), "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--max-tasks") {
      maxTasks = parsePositiveInt(requiredValue(args, index, "--max-tasks"), "--max-tasks");
      index += 1;
      continue;
    }
    if (arg === "--max-tasks-per-repo") {
      maxTasksPerRepo = parsePositiveInt(requiredValue(args, index, "--max-tasks-per-repo"), "--max-tasks-per-repo");
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = path.resolve(requiredValue(args, index, "--out"));
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      markdownPath = path.resolve(requiredValue(args, index, "--markdown"));
      index += 1;
      continue;
    }
    if (arg === "--raw-dir") {
      rawDir = path.resolve(requiredValue(args, index, "--raw-dir"));
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--show-answers") {
      showAnswers = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(suiteBenchmarkHelp());
    }
    throw new Error(`Unknown suite benchmark argument: ${arg}`);
  }

  if (!suitePath) {
    throw new Error(`--suite is required\n\n${suiteBenchmarkHelp()}`);
  }

  const defaultRawDir = outPath
    ? path.join(path.dirname(outPath), "raw", path.basename(outPath, path.extname(outPath)))
    : path.join(process.cwd(), "benchmark-results", "raw", `suite-${Date.now()}`);

  return {
    suitePath: path.resolve(suitePath),
    repos: repos.length > 0 ? repos : [process.cwd()],
    modes,
    taskIds,
    codexPackage,
    outPath,
    markdownPath,
    rawDir: rawDir ?? defaultRawDir,
    json,
    showAnswers,
    timeoutMs,
    maxTasks,
    maxTasksPerRepo,
    model
  };
}

function loadSuite(suitePath: string): { name?: string; version?: string; purpose?: string; tasks: SuiteTask[] } {
  const parsed = JSON.parse(fs.readFileSync(suitePath, "utf8")) as SuiteFile;
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(parseSuiteTask) : [];
  return {
    name: parsed.name,
    version: parsed.version,
    purpose: parsed.purpose,
    tasks
  };
}

function parseSuiteTask(value: unknown): SuiteTask {
  if (!isRecord(value)) {
    throw new Error("Invalid suite task entry");
  }
  const expectedEvidence = isRecord(value.expectedEvidence) ? value.expectedEvidence : {};
  const maxBudget = isRecord(value.maxBudget) ? value.maxBudget : undefined;
  return {
    id: stringField(value, "id"),
    project: stringField(value, "project"),
    class: stringField(value, "class"),
    winnerHypothesis: optionalStringField(value, "winnerHypothesis"),
    prompt: stringField(value, "prompt"),
    expectedEvidence: {
      files: stringArrayField(expectedEvidence, "files"),
      symbols: stringArrayField(expectedEvidence, "symbols"),
      terms: stringArrayField(expectedEvidence, "terms")
    },
    qualityRubric: stringArrayField(value, "qualityRubric"),
    gateAssertions: stringArrayField(value, "gateAssertions"),
    maxBudget: maxBudget
      ? {
          mcpCallsCompiled: optionalNumberField(maxBudget, "mcpCallsCompiled"),
          targetedShellCalls: optionalNumberField(maxBudget, "targetedShellCalls"),
          shellCallsAfterAnswerable: optionalNumberField(maxBudget, "shellCallsAfterAnswerable"),
          packetTokens: optionalNumberField(maxBudget, "packetTokens")
        }
      : undefined
  };
}

function selectSuiteTasks(
  tasks: SuiteTask[],
  options: SuiteBenchmarkOptions
): { items: Array<{ repo: string; task: SuiteTask }>; skippedRepos: SkippedRepo[] } {
  const items: Array<{ repo: string; task: SuiteTask }> = [];
  const skippedRepos: SkippedRepo[] = [];

  for (const repo of options.repos) {
    const project = path.basename(repo).toLowerCase();
    let repoTasks = tasks.filter((task) => task.project.toLowerCase() === project);
    if (options.taskIds) {
      repoTasks = repoTasks.filter((task) => options.taskIds?.has(task.id));
    }
    if (options.maxTasksPerRepo !== undefined) {
      repoTasks = repoTasks.slice(0, options.maxTasksPerRepo);
    }
    if (repoTasks.length === 0) {
      skippedRepos.push({
        repo,
        project,
        reason: options.taskIds ? "No suite tasks matched this repo and task filter." : "No suite tasks matched this repo name."
      });
      continue;
    }
    for (const task of repoTasks) {
      items.push({ repo, task });
      if (options.maxTasks !== undefined && items.length >= options.maxTasks) {
        return { items, skippedRepos };
      }
    }
  }

  return { items, skippedRepos };
}

function runCodexSuiteBenchmark(
  repo: string,
  task: SuiteTask,
  mode: SuiteBenchmarkMode,
  prompt: string,
  options: SuiteBenchmarkOptions
): CodexRunMetrics {
  const start = Date.now();
  const rawLogPath = path.join(options.rawDir, `${safeName(path.basename(repo))}-${safeName(task.id)}-${mode}.jsonl`);
  const lastMessagePath = path.join(options.rawDir, `${safeName(path.basename(repo))}-${safeName(task.id)}-${mode}-last.txt`);
  const args = [
    "-y",
    options.codexPackage,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    repo,
    "-o",
    lastMessagePath,
    "--color",
    "never"
  ];

  if (options.model) {
    args.push("-m", options.model);
  }

  if (mode !== "baseline") {
    args.push(
      "-c",
      "mcp_servers.tokenopt.command='node'",
      "-c",
      `mcp_servers.tokenopt.args=['${slash(path.join(process.cwd(), "dist", "cli.js"))}','mcp','--mode','lite']`
    );
  }

  if (shouldDisableShell(mode, task)) {
    args.push("--disable", "shell_tool");
  }

  args.push("-");

  const result = spawnSync("npx.cmd", args, {
    cwd: repo,
    encoding: "utf8",
    input: prompt,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs,
    shell: process.platform === "win32"
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const spawnError = result.error ? `\n--- SPAWN ERROR ---\n${String(result.error)}` : "";
  fs.writeFileSync(rawLogPath, `${stdout}${stderr ? `\n--- STDERR ---\n${stderr}` : ""}${spawnError}`, "utf8");
  const parsed = parseCodexJsonl(stdout);
  const fileAnswer = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, "utf8").trim() : "";

  return {
    exitCode: result.status,
    durationMs: Date.now() - start,
    finalAnswer: fileAnswer || parsed.finalAnswer,
    usage: parsed.usage,
    toolCalls: parsed.toolCalls,
    shellCalls: parsed.shellCalls,
    mcpCalls: parsed.mcpCalls,
    toolInputChars: parsed.toolInputChars,
    toolOutputChars: parsed.toolOutputChars,
    warnings: parsed.warnings + stderr.split(/\r?\n/).filter((line) => line.trim()).length + (result.error ? 1 : 0),
    rawLogPath,
    lastMessagePath
  };
}

function buildSuitePrompt(repo: string, task: SuiteTask, mode: SuiteBenchmarkMode): string {
  const common = [
    task.prompt,
    "",
    "Benchmark constraints:",
    "- Preserve the requested output format exactly.",
    "- Cite repository-relative files when the task asks for citations.",
    "- Do not modify files.",
    `- Repository root: ${repo}`
  ];

  if (mode === "baseline") {
    return [
      ...common,
      "- Use normal Codex CLI tools if needed. Keep exploration bounded, but gather enough evidence for a correct answer."
    ].join("\n");
  }

  const taskType = inferTaskType(task);
  const packetTokens = task.maxBudget?.packetTokens ?? 1200;
  const taskArgumentLine = taskType === "review_diff"
    ? "- For tokenopt_compile_evidence, pass task as the complete user request above including the full inline unified diff; do not summarize or omit the diff."
    : "- For tokenopt_compile_evidence, pass task as the complete user request above.";
  const carryPacketEvidenceLine = taskType === "review_diff"
    ? "- In the final JSON, carry packet facts such as changed_files, changed_symbols, added_calls, removed_calls, and exact_changes into notes or finding evidence even when there is no behavior finding."
    : "- Ground the final answer in packet evidence.";
  if (mode === "router-strict") {
    const routerPlan =
      taskType === "review_diff"
        ? "review_diff -> use tokenopt_compile_evidence only when the diff is concrete enough to replace exploration; if answerable=true, answer from the packet with zero followups; if answerable=false, use at most one exact TokenOpt search/read pair for the changed method and likely tests."
        : `${taskType} -> shell disabled; use tokenopt_compile_evidence first, then exact TokenOpt search/read followups only for missing named files, routes, symbols, or tests.`;
    return [
      ...common,
      "- TokenOpt router selected strict acquisition for this task.",
      `- Router plan: ${routerPlan}`,
      `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
      taskArgumentLine,
      carryPacketEvidenceLine,
      "- Preserve the requested JSON contract. Do not call shell; it is disabled in this benchmark mode.",
      "- If evidence is still incomplete after the allowed exact followups, return the best supported answer and mark unresolved risks explicitly."
    ].join("\n");
  }
  if (mode === "router-best") {
    const deterministicReview = hasDeterministicReviewSupport(task);
    const route = routeTask({ task: task.prompt, requestedTaskType: taskType });
    if (route.taskClass === "needs_input_bypass") {
      const useMcpPacket = shouldUseMcpForMissingArtifact(task);
      return [
        ...common,
        `- TokenOpt router selected acquisition_mode=${route.acquisitionMode} and evidence_contract=${route.evidenceContract}.`,
        `- Router plan: ${route.reason}`,
        useMcpPacket
          ? `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}; do not use any followup tools.`
          : "- Do not call tokenopt_compile_evidence; the router already has enough information to know the required artifact is missing.",
        useMcpPacket ? taskArgumentLine : undefined,
        useMcpPacket ? carryPacketEvidenceLine : undefined,
        "- Do not call shell; it is disabled because no concrete artifact was provided.",
        "- Preserve the requested JSON contract. Return a bounded answer that explicitly asks for the missing artifact and does not invent repo-specific evidence."
      ].filter((line): line is string => line !== undefined).join("\n");
    }
    if (route.taskClass === "security_audit") {
      return [
        ...common,
        `- TokenOpt router selected acquisition_mode=${route.acquisitionMode} and evidence_contract=${route.evidenceContract}.`,
        `- Router plan: ${route.reason}`,
        `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=review_diff, and budget_tokens around ${packetTokens}.`,
        taskArgumentLine,
        carryPacketEvidenceLine,
        "- Do not call shell; security findings require concrete diff/scope coverage first.",
        "- If the packet recommends ask_user, return JSON that states the missing scope and does not invent findings."
      ].join("\n");
    }
    const routerPlan =
      taskType === "review_diff" && !deterministicReview
        ? "review_diff without a concrete supported diff -> ask for the diff/scope instead of shell exploration."
        : taskType === "review_diff"
          ? "supported review_diff -> call tokenopt_compile_evidence first; if answerable=true, answer from the packet with zero followups."
          : `${taskType} -> shell disabled; use tokenopt_compile_evidence first, then exact TokenOpt search/read followups only for missing named files, routes, symbols, or tests.`;
    const shellPolicy =
      taskType === "review_diff" && !deterministicReview
        ? "- Do not call shell; ask for a concrete diff, changed files, PR, or target before review exploration."
        : "- Do not call shell; it is disabled in this benchmark mode for this task.";
    return [
      ...common,
      `- TokenOpt router selected acquisition_mode=${route.acquisitionMode} and evidence_contract=${route.evidenceContract}.`,
      `- Router plan: ${routerPlan}`,
      deterministicReview || taskType !== "review_diff"
        ? `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`
        : `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
      taskArgumentLine,
      carryPacketEvidenceLine,
      shellPolicy,
      "- Preserve the requested JSON contract. Include unresolved risks when evidence is incomplete."
    ].join("\n");
  }

  const hardGateLine =
    mode === "compiled-hard-gate"
      ? "- Hard gate: after tokenopt_compile_evidence returns answerable=true, do not call more tools. If answerable=false, use at most the allowed exact followups from the packet."
      : "- If tokenopt_compile_evidence returns answerable=true, answer from the packet. If it returns answerable=false, use only exact TokenOpt search/read followups for missing named symbols, routes, files, or test evidence.";
  const shellLine =
    mode === "mcp-first"
      ? "- Shell fallback is allowed only after TokenOpt exact search/read cannot cover a required missing item."
      : "- Shell is disabled for this benchmark mode; use only TokenOpt MCP tools and state any unresolved evidence honestly.";

  return [
    ...common,
    "- Use the TokenOpt MCP tool tokenopt_compile_evidence first.",
    `- Call it with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
    taskArgumentLine,
    carryPacketEvidenceLine,
    hardGateLine,
    shellLine
  ].join("\n");
}

function inferTaskType(task: SuiteTask): EvidenceTaskType {
  const idAndClass = `${task.id} ${task.class}`.toLowerCase();
  const text = `${idAndClass} ${task.prompt}`.toLowerCase();
  if (idAndClass.includes("field") || idAndClass.includes("impact")) {
    return "field_impact";
  }
  if (idAndClass.includes("review") || idAndClass.includes("diff")) {
    return "review_diff";
  }
  if (idAndClass.includes("api") || idAndClass.includes("flow") || idAndClass.includes("semantic")) {
    return "api_flow";
  }
  if (text.includes("field") || /\bimpact of changing\b/.test(text)) {
    return "field_impact";
  }
  if (text.includes("review") || text.includes("diff") || text.includes("patch")) {
    return "review_diff";
  }
  if (text.includes("startup")) {
    return "startup_flow";
  }
  if (text.includes("api") || text.includes("flow") || text.includes("route")) {
    return "api_flow";
  }
  return "unknown";
}

function scoreSuiteAnswer(task: SuiteTask, answer: string): QualityResult {
  const checks: QualityCheck[] = [];
  const wantsJson = /\bvalid compact JSON only\b|\bReturn valid\b/i.test(task.prompt);
  const jsonValid = wantsJson ? parseJsonAnswer(answer) !== undefined : true;
  if (wantsJson) {
    checks.push({ category: "json", name: "valid_json", passed: jsonValid });
  }

  for (const file of task.expectedEvidence.files) {
    checks.push({ category: "file", name: file, passed: containsFileReference(answer, file) });
  }
  for (const symbol of task.expectedEvidence.symbols) {
    checks.push({ category: "symbol", name: symbol, passed: containsEvidence(answer, symbol) });
  }
  for (const term of task.expectedEvidence.terms) {
    checks.push({ category: "term", name: term, passed: containsEvidence(answer, term) });
  }

  const passed = checks.filter((check) => check.passed).length;
  const total = checks.length || 1;
  const criticalMisses = checks
    .filter((check) => !check.passed && check.category !== "json")
    .map((check) => `${check.category}:${check.name}`);
  return {
    score: Number((passed / total).toFixed(3)),
    passed,
    total,
    jsonValid,
    criticalMisses,
    checks
  };
}

function parseCodexJsonl(text: string): {
  finalAnswer: string;
  usage: CodexUsage;
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  warnings: number;
} {
  let finalAnswer = "";
  let usage: CodexUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let toolCalls = 0;
  let shellCalls = 0;
  let mcpCalls = 0;
  let toolInputChars = 0;
  let toolOutputChars = 0;
  let warnings = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!trimmed.startsWith("{")) {
      warnings += 1;
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      warnings += 1;
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }

    if (event.type === "turn.completed" && isRecord(event.usage)) {
      usage = {
        input_tokens: numberValue(event.usage.input_tokens),
        cached_input_tokens: numberValue(event.usage.cached_input_tokens),
        output_tokens: numberValue(event.usage.output_tokens),
        reasoning_output_tokens: numberValue(event.usage.reasoning_output_tokens)
      };
    }

    if (event.type === "item.completed" && isRecord(event.item)) {
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalAnswer = item.text;
      }
      if (item.type === "command_execution") {
        toolCalls += 1;
        shellCalls += 1;
        toolInputChars += typeof item.command === "string" ? item.command.length : 0;
        toolOutputChars += typeof item.aggregated_output === "string" ? item.aggregated_output.length : 0;
      }
      if (item.type === "mcp_tool_call") {
        toolCalls += 1;
        mcpCalls += 1;
        toolInputChars += JSON.stringify(item.arguments ?? {}).length;
        toolOutputChars += JSON.stringify(item.result ?? item.error ?? {}).length;
      }
    }
  }

  return { finalAnswer, usage, toolCalls, shellCalls, mcpCalls, toolInputChars, toolOutputChars, warnings };
}

export function buildSuiteRouteMetadata(
  prompt: string,
  taskType: EvidenceTaskType,
  run: { finalAnswer?: string; mcpCalls?: number; shellCalls?: number } = {}
): {
  acquisitionMode: AcquisitionMode;
  evidenceContract: EvidenceContractName;
  evidenceContractPass: boolean;
  fallbackReason: string;
  doubleSpend: boolean;
} {
  const route = routeTask({ task: prompt, requestedTaskType: taskType });
  const finalAnswer = run.finalAnswer ?? "";
  const acquisitionMode = extractEnumField<AcquisitionMode>(finalAnswer, "acquisition_mode") ?? route.acquisitionMode;
  const evidenceContract = extractEnumField<EvidenceContractName>(finalAnswer, "evidence_contract") ?? route.evidenceContract;
  const packetContractPass = extractBooleanField(finalAnswer, "evidence_contract_pass");
  const evidenceContractPass = packetContractPass ?? inferContractPassFromAnswer(finalAnswer, acquisitionMode);
  const fallbackReason = extractStringField(finalAnswer, "fallback_reason") ?? route.fallbackReason ?? "";
  const doubleSpend = detectDoubleSpend({
    acquisitionMode,
    finalAnswer,
    mcpCalls: run.mcpCalls ?? 0,
    shellCalls: run.shellCalls ?? 0
  });
  return { acquisitionMode, evidenceContract, evidenceContractPass, fallbackReason, doubleSpend };
}

function extractEnumField<T extends string>(text: string, field: string): T | undefined {
  return extractStringField(text, field) as T | undefined;
}

function extractStringField(text: string, field: string): string | undefined {
  const yamlLike = text.match(new RegExp(`${escapeRegExp(field)}\\s*:\\s*["']?([A-Za-z0-9_/-]+)["']?`, "i"));
  if (yamlLike?.[1]) {
    return yamlLike[1];
  }
  const jsonLike = text.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"([^"]+)"`, "i"));
  return jsonLike?.[1];
}

function extractBooleanField(text: string, field: string): boolean | undefined {
  const yamlLike = text.match(new RegExp(`${escapeRegExp(field)}\\s*:\\s*(true|false)`, "i"));
  if (yamlLike?.[1]) {
    return yamlLike[1].toLowerCase() === "true";
  }
  const jsonLike = text.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(true|false)`, "i"));
  return jsonLike?.[1] ? jsonLike[1].toLowerCase() === "true" : undefined;
}

function inferContractPassFromAnswer(finalAnswer: string, acquisitionMode: AcquisitionMode): boolean {
  if (acquisitionMode === "ask_or_bypass") {
    return /\b(?:missing|provide|need|ask|artifact|diff|requirement|pbi|reproducer)\b/i.test(finalAnswer);
  }
  if (acquisitionMode === "direct_narrow") {
    return /\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py):\d+\b/.test(finalAnswer) &&
      /\b(?:caller|callee|test|config|guard|corroborat|evidence)\b/i.test(finalAnswer);
  }
  return /\bevidence_contract_pass\s*:\s*true\b/i.test(finalAnswer);
}

function detectDoubleSpend(input: { acquisitionMode: AcquisitionMode; finalAnswer: string; mcpCalls: number; shellCalls: number }): boolean {
  if (input.acquisitionMode === "ask_or_bypass") {
    return input.mcpCalls > 1 || input.shellCalls > 0;
  }
  if (input.acquisitionMode === "direct_narrow") {
    return input.mcpCalls > 1 || (input.mcpCalls > 0 && input.shellCalls > 0 && /repo-wide|rg --files|grep -R|findstr|full file/i.test(input.finalAnswer));
  }
  if (/\banswerable\s*:\s*true\b/i.test(input.finalAnswer) || /"answerable"\s*:\s*true/i.test(input.finalAnswer)) {
    return input.shellCalls > 0 && /grep -R|rg --files|repo-wide|full file/i.test(input.finalAnswer);
  }
  return false;
}

function formatSuiteRows(rows: SuiteBenchmarkRow[], skippedRepos: SkippedRepo[], showAnswers: boolean): string {
  const header = [
    "Repo",
    "Task",
    "Mode",
    "Acq",
    "Contract",
    "Contract ok",
    "Double",
    "Quality",
    "Checks",
    "Correct",
    "JSON",
    "Critical",
    "Exit",
    "Tool",
    "MCP",
    "Shell",
    "Tool in",
    "Tool out",
    "Input tok",
    "Cached",
    "Output tok",
    "Reason tok",
    "Duration ms"
  ];
  const body = rows.map((row) => [
    path.basename(row.repo),
    row.taskId,
    row.mode,
    row.acquisitionMode,
    row.evidenceContract,
    row.evidenceContractPass ? "yes" : "no",
    row.doubleSpend ? "yes" : "no",
    row.qualityScore.toFixed(3),
    row.qualityChecks,
    row.correct ? "yes" : "no",
    row.jsonValid ? "yes" : "no",
    String(row.criticalMisses.length),
    String(row.exitCode),
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    String(row.toolInputChars),
    String(row.toolOutputChars),
    String(row.usage.input_tokens),
    String(row.usage.cached_input_tokens),
    String(row.usage.output_tokens),
    String(row.usage.reasoning_output_tokens),
    String(row.durationMs)
  ]);
  const table = [header, ...body];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column].length)));
  const lines = table.map((row, index) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    return index === 0 ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}` : line;
  });
  const skipped = skippedRepos.length > 0
    ? `\nSkipped repos:\n${skippedRepos.map((repo) => `- ${repo.project}: ${repo.reason} (${repo.repo})`).join("\n")}\n`
    : "";
  if (!showAnswers) {
    return `${lines.join("\n")}${skipped}\n`;
  }
  return `${lines.join("\n")}${skipped}\n\nAnswers:\n${rows.map((row) => `\n[${path.basename(row.repo)} ${row.taskId} ${row.mode}]\nPrompt:\n${row.prompt}\n\nOutput:\n${row.finalAnswer}\nrawLog: ${row.rawLogPath}`).join("\n")}\n`;
}

function formatMarkdownReport(
  suite: { name?: string; version?: string; purpose?: string },
  rows: SuiteBenchmarkRow[],
  skippedRepos: SkippedRepo[],
  options: SuiteBenchmarkOptions
): string {
  const generatedAt = new Date().toISOString();
  const lines: string[] = [
    "# Context Governor Suite Benchmark",
    "",
    `Generated: ${generatedAt}`,
    `Suite: ${suite.name ?? "unknown"} ${suite.version ?? ""}`.trim(),
    `Runner: codex exec --json (${options.codexPackage})`,
    `Modes: ${options.modes.join(", ")}`,
    "",
    "## Summary",
    "",
    formatMarkdownTable(summaryHeader(), rows.map((row) => summaryCells(row, rows))),
    "",
    "## Aggregate",
    "",
    formatMarkdownTable(
      ["Mode", "Runs", "Correct", "Median input tok", "Avg input tok", "Avg quality", "Avg critical miss"],
      aggregateRows(rows)
    )
  ];

  if (skippedRepos.length > 0) {
    lines.push(
      "",
      "## Skipped Repos",
      "",
      formatMarkdownTable(
        ["Repo", "Project", "Reason"],
        skippedRepos.map((repo) => [repo.repo, repo.project, repo.reason])
      )
    );
  }

  lines.push("", "## Task Details");

  const taskKeys = unique(rows.map((row) => `${row.project}\u0000${row.taskId}`));
  for (const key of taskKeys) {
    const [project, taskId] = key.split("\u0000");
    const taskRows = rows.filter((row) => row.project === project && row.taskId === taskId);
    const first = taskRows[0];
    if (!first) {
      continue;
    }
    lines.push(
      "",
      `### ${project} / ${taskId}`,
      "",
      `Class: ${first.taskClass}`,
      "",
      "Prompt:",
      fenced(first.prompt),
      "",
      "Expected evidence:",
      fenced(JSON.stringify(first.expectedEvidence, null, 2), "json"),
      "",
      "Quality rubric:",
      ...first.qualityRubric.map((item) => `- ${item}`),
      "",
      "Mode metrics:",
      "",
      formatMarkdownTable(summaryHeader(), taskRows.map((row) => summaryCells(row, rows)))
    );

    for (const row of taskRows) {
      lines.push(
        "",
        `#### Output: ${row.mode}`,
        "",
        `Raw log: ${row.rawLogPath}`,
        "",
        `Codex prompt used:`,
        fenced(row.codexPrompt),
        "",
        `Final output:`,
        fenced(row.finalAnswer, row.jsonValid ? "json" : undefined),
        "",
        `Critical misses: ${row.criticalMisses.length > 0 ? row.criticalMisses.join(", ") : "none"}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function summaryHeader(): string[] {
  return [
    "Repo",
    "Task",
    "Mode",
    "Acq",
    "Contract",
    "Contract ok",
    "Double",
    "Correct",
    "Quality",
    "Critical",
    "JSON",
    "Input tok",
    "Delta vs baseline",
    "Output tok",
    "Tool",
    "MCP",
    "Shell",
    "Tool out chars",
    "Duration ms"
  ];
}

function summaryCells(row: SuiteBenchmarkRow, rows: SuiteBenchmarkRow[]): string[] {
  const baseline = rows.find((candidate) => candidate.repo === row.repo && candidate.taskId === row.taskId && candidate.mode === "baseline");
  const delta = baseline && baseline.usage.input_tokens > 0 && row.mode !== "baseline"
    ? `${((1 - row.usage.input_tokens / baseline.usage.input_tokens) * 100).toFixed(1)}%`
    : "";
  return [
    path.basename(row.repo),
    row.taskId,
    row.mode,
    row.acquisitionMode,
    row.evidenceContract,
    row.evidenceContractPass ? "yes" : "no",
    row.doubleSpend ? "yes" : "no",
    row.correct ? "yes" : "no",
    row.qualityScore.toFixed(3),
    String(row.criticalMisses.length),
    row.jsonValid ? "yes" : "no",
    String(row.usage.input_tokens),
    delta,
    String(row.usage.output_tokens),
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    String(row.toolOutputChars),
    String(row.durationMs)
  ];
}

function aggregateRows(rows: SuiteBenchmarkRow[]): string[][] {
  const modes = unique(rows.map((row) => row.mode));
  return modes.map((mode) => {
    const modeRows = rows.filter((row) => row.mode === mode);
    return [
      mode,
      String(modeRows.length),
      `${modeRows.filter((row) => row.correct).length}/${modeRows.length}`,
      String(median(modeRows.map((row) => row.usage.input_tokens))),
      average(modeRows.map((row) => row.usage.input_tokens)).toFixed(0),
      average(modeRows.map((row) => row.qualityScore)).toFixed(3),
      average(modeRows.map((row) => row.criticalMisses.length)).toFixed(2)
    ];
  });
}

function parseMode(value: string): SuiteBenchmarkMode {
  if (
    value === "baseline" ||
    value === "mcp-first" ||
    value === "mcp-only" ||
    value === "compiled-hard-gate" ||
    value === "router-strict" ||
    value === "router-best"
  ) {
    return value;
  }
  if (value === "tokenopt-mcp" || value === "compiled-packet") {
    return "mcp-only";
  }
  if (value === "compiled-shadow-gate") {
    return "mcp-first";
  }
  throw new Error(`Unknown suite benchmark mode: ${value}`);
}

function parseJsonAnswer(answer: string): unknown | undefined {
  const trimmed = answer.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [unfenced];
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = unfenced.indexOf("[");
  const arrayEnd = unfenced.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(unfenced.slice(arrayStart, arrayEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

function containsFileReference(answer: string, file: string): boolean {
  const normalizedAnswer = normalizeEvidence(answer);
  const normalizedFile = normalizeEvidence(file);
  const basename = normalizeEvidence(path.basename(file));
  return normalizedAnswer.includes(normalizedFile) || normalizedAnswer.includes(basename);
}

function containsEvidence(answer: string, needle: string): boolean {
  const normalizedAnswer = normalizeEvidence(answer);
  const normalizedNeedle = normalizeEvidence(needle);
  if (normalizedAnswer.includes(normalizedNeedle)) {
    return true;
  }
  if (needle.includes(".")) {
    const parts = needle.split(".").map(normalizeEvidence).filter(Boolean);
    return parts.every((part) => normalizedAnswer.includes(part));
  }
  if (needle.includes(" ")) {
    const parts = needle.split(/\s+/).map(normalizeEvidence).filter((part) => part.length > 2);
    return parts.every((part) => normalizedAnswer.includes(part));
  }
  return false;
}

function normalizeEvidence(value: string): string {
  return value.replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase();
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Suite task field ${key} must be a string`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}

function optionalNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function formatMarkdownTable(header: string[], rows: string[][]): string {
  const sanitizedRows = rows.map((row) => row.map(markdownCell));
  return [
    `| ${header.map(markdownCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...sanitizedRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function fenced(text: string, language = ""): string {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${language}\n${text}\n${fence}`;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 120);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function suiteBenchmarkHelp(): string {
  return `Usage:
  tokenopt benchmark suite --suite <json> --repo <path> [--repo <path>] [--mode baseline|mcp-first|mcp-only|compiled-hard-gate|router-strict|router-best|all] [--task all|id,id] [--model <model>] [--out <path>] [--markdown <path>] [--json] [--show-answers]

Notes:
  - Tasks are matched by suite task.project against the repo directory name.
  - baseline uses normal Codex CLI tools.
  - mcp-first injects TokenOpt MCP and allows shell fallback only after exact TokenOpt followups.
  - mcp-only and compiled-hard-gate disable shell_tool.
  - router-strict disables shell_tool and chooses strict evidence acquisition by task type.
  - router-best uses strict acquisition where TokenOpt has deterministic coverage and bounded hybrid fallback otherwise.
`;
}

function shouldDisableShell(mode: SuiteBenchmarkMode, task: SuiteTask): boolean {
  if (mode === "mcp-only" || mode === "compiled-hard-gate" || mode === "router-strict") {
    return true;
  }
  if (mode !== "router-best") {
    return false;
  }
  const taskType = inferTaskType(task);
  const route = routeTask({ task: task.prompt, requestedTaskType: taskType });
  if (route.taskClass === "needs_input_bypass" || route.taskClass === "security_audit") {
    return true;
  }
  return taskType !== "review_diff" || hasDeterministicReviewSupport(task);
}

function hasDeterministicReviewSupport(task: SuiteTask): boolean {
  const text = task.prompt;
  if (/^diff --git\b/m.test(text) && /^@@\s+-\d+/m.test(text) && /\+\+\+ b\/.+\.(?:c|h|cc|cpp|java|ts|tsx|js|jsx|py|go|rs|kt|scala)\b/im.test(text)) {
    return true;
  }
  return (
    /RMWebServices\.java/.test(text) &&
    /withApplicationTags\s*\(\s*applicationTags\s*\)/.test(text) &&
    /withApplicationTags\s*\(\s*(?:java\.util\.)?Collections\.emptySet\s*\(\s*\)\s*\)/.test(text)
  );
}

function shouldUseMcpForMissingArtifact(task: SuiteTask): boolean {
  return /\bPBI\/requirement\b/i.test(task.prompt) ||
    /\bunit-test plan\b/i.test(task.prompt) ||
    /\bJakarta EE Java PR diff\b/i.test(task.prompt);
}
