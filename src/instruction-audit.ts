import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./log-compressor.js";

export type InstructionTarget = "agents" | "codex" | "copilot" | "copilot-path" | "copilot-agent" | "generic";

interface AuditFile {
  path: string;
  bytes: number;
  estimatedTokens: number;
  duplicateLines: number;
  conflicts: string[];
}

export interface InstructionGraphFile {
  path: string;
  content: string;
  estimatedTokens: number;
}

export interface InstructionGraphPlan {
  files: InstructionGraphFile[];
  totalEstimatedTokens: number;
  warnings: string[];
}

export interface NativePromptPackPlan {
  files: InstructionGraphFile[];
  totalEstimatedTokens: number;
}

export function auditInstructions(repoRoot: string): string {
  const files = findInstructionFiles(repoRoot);
  if (files.length === 0) {
    return "TokenOpt instruction audit\n\nNo AGENTS.md or GitHub Copilot instruction files found.";
  }

  const audits = files.map((file) => auditFile(file));
  const totalTokens = audits.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const lines = [
    "TokenOpt instruction audit",
    "",
    `files: ${audits.length}`,
    `estimatedTokens: ${totalTokens}`,
    "",
    ...audits.flatMap((audit) => formatAudit(audit, repoRoot))
  ];
  return lines.join("\n").trimEnd();
}

export function emitTokenOptInstructions(target: InstructionTarget = "generic"): string {
  if (target === "copilot-path") {
    return [
      "---",
      "applyTo: \"**\"",
      "---",
      "",
      emitTokenOptInstructions("copilot")
    ].join("\n");
  }
  if (target === "copilot-agent") {
    return [
      "---",
      "name: tokenopt-cost-gate",
      "description: Use for broad repository handoff, business/domain research, implementation planning, and unit-test planning tasks where TokenOpt MCP can replace broad exploration.",
      "tools: [\"tokenopt/tokenopt_compile_evidence\", \"tokenopt/tokenopt_search\", \"tokenopt/tokenopt_read_file\", \"search\", \"read\"]",
      "---",
      "",
      "# TokenOpt Cost Gate Agent",
      "",
      "Use TokenOpt MCP as a cost gate for broad repo tasks. Do not treat it as a mandatory extra step.",
      "",
      "Natural prompts that should trigger TokenOpt first:",
      "",
      "```text",
      "- Study or summarize a business/domain area from repo evidence",
      "- Prepare build, onboarding, or daily handoff",
      "- Plan implementation before editing",
      "- Plan unit tests before writing them",
      "- Investigate a broad failure surface before choosing exact files",
      "```",
      "",
      "Native Copilot prompt files may also be installed under `.github/prompts`: `/pbi-plan`, `/requirement-analysis`, `/write-unittest`, `/security-audit`, `/review-code`, and `/promote-review-memory`.",
      "",
      "Workflow:",
      "",
      "```text",
      "1. Call tokenopt_compile_evidence with the user's task, inferred task_type, cwd, budget_tokens around 1200, and a concrete quality_rubric.",
      "2. If answerable=true, answer from the packet with zero redundant search/read.",
      "3. If answerable=false, use only tokenopt_search/tokenopt_read_file followups from the packet.",
      "4. If the task is an exact code-flow/class/PBI deep dive that will need line-level proof, report that TokenOpt is not the cheapest first step and use normal narrow search/read outside this agent.",
      "```"
    ].join("\n");
  }
  const heading =
    target === "copilot"
      ? "# TokenOpt MCP Usage"
      : "## TokenOpt MCP Usage";
  return [
    heading,
    "",
    "When the TokenOpt MCP server is available, treat it as a cost gate, not a mandatory extra step before normal tools.",
    "",
    "Use TokenOpt first only when it can replace broad exploration:",
    "",
    "```text",
    "- Build/daily/onboarding handoff",
    "- Repo overview or project facts",
    "- Business/product/domain summary from docs/inventory",
    "- Implementation planning before editing",
    "- Unit-test planning before writing tests",
    "```",
    "",
    "If `.github/prompts` is installed, users may call native Copilot prompt files such as `/pbi-plan`, `/requirement-analysis`, `/write-unittest`, `/security-audit`, `/review-code`, or `/promote-review-memory`. Treat those prompt files as normal user intent plus the routing rules in this instruction file.",
    "",
    "Quality-first routing guardrails:",
    "",
    "```text",
    "- Missing artifact: if PBI/requirement/unit-test/review-memory/review prompts lack the concrete artifact, ask for it and do not inspect the repo.",
    "- Security audit: require concrete diff/scope and security coverage before findings; use exact followups only.",
    "- Coding coverage: for implement/write_unittest/fix/debug, require concrete target symbol/file/behavior/failure; cap write_unittest followups to one.",
    "- Review: diff-first and scope-first; no diff/scope means ask for it, not shell exploration.",
    "```",
    "",
    "Do not use TokenOpt first when it would create MCP+shell double-spend:",
    "",
    "```text",
    "- Exact existing-flow tracing that needs line-level code proof",
    "- Specific class/method/PBI deep dive where shell/search reads are still required",
    "- Review tasks without a concrete diff or patch for TokenOpt to inspect",
    "```",
    "",
    "For those exact-code tasks, either use normal narrow shell/search/read directly, or run a strict MCP-only session where shell is disabled. Do not call TokenOpt first and then repeat the same acquisition with shell.",
    "",
    "Required first step:",
    "",
    "```text",
    "When the cost gate says TokenOpt is appropriate, call tokenopt_compile_evidence with:",
    "- task: the user's task",
    "- task_type: one of build_handoff, investigate, research_business, implement, write_unittest, api_flow, field_impact, review_diff, startup_flow, unknown",
    "- cwd: the current repository root",
    "- budget_tokens: 1200-2000",
    "- quality_rubric: 3-6 concrete checks the final answer must satisfy",
    "```",
    "",
    "After the evidence packet:",
    "",
    "```text",
    "If answerable=true and recommended_next_action=answer_now:",
    "- Answer from the packet.",
    "- Cite evidence IDs, files, facts, and missing=[] from the packet.",
    "- Do not call shell, grep, search, read_file, project_facts, run_command, or more MCP tools just to verify the same evidence.",
    "",
    "If missing is non-empty:",
    "- Use only allowed_followups from the packet.",
    "- Keep followups exact and bounded.",
    "- Do not run repo-wide rg --files, broad grep/search, full-file reads, or full-suite tests unless the packet explicitly allows it.",
    "```",
    "",
    "Tool policy:",
    "",
    "```text",
    "Prefer tokenopt_compile_evidence over broad raw shell exploration only when it replaces that exploration.",
    "Use tokenopt_search only for exact patterns and narrow paths.",
    "Use tokenopt_read_file only for bounded slices around exact matches.",
    "Default lite mode exposes only compile_evidence, search, and read_file to reduce MCP schema/context overhead.",
    "Use tokenopt_run_command for builds/tests only when that tool is visible/full mode is explicitly enabled.",
    "Do not bypass TokenOpt with shell fallback after an answerable packet.",
    "Do not do MCP-first plus shell fallback for exact code-flow/class/PBI tasks; that is expected to increase input tokens.",
    "```",
    "",
    "Daily task mapping:",
    "",
    "```text",
    "Build or onboarding handoff -> task_type=build_handoff",
    "Debugging, triage, why something fails -> task_type=investigate",
    "Business/product/domain research or deep dive -> task_type=research_business",
    "Implementation planning or small code change -> task_type=implement",
    "Unit-test planning or test-writing task -> task_type=write_unittest",
    "Existing business/API/user flow, flowchart, sequence diagram, or Mermaid request -> task_type=api_flow",
    "Field/schema impact -> task_type=field_impact",
    "Diff or PR review -> task_type=review_diff",
    "Startup/bootstrap flow -> task_type=startup_flow",
    "```",
    "",
    "Final answer requirements:",
    "",
    "```text",
    "Use concise headings.",
    "Include what is known, evidence used, missing items if any, and exact next steps.",
    "Mention when TokenOpt marked the task answerable.",
    "Avoid saying more exploration is needed when missing=[] and answerable=true.",
    "```"
  ].join("\n");
}

export function installTokenOptInstructions(repoRoot: string, target: Exclude<InstructionTarget, "generic">): string {
  const filePath = instructionTargetPath(repoRoot, target);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const snippet = emitTokenOptInstructions(target);
  if (target === "copilot-path" || target === "copilot-agent") {
    fs.writeFileSync(filePath, `${snippet.trimEnd()}\n`, "utf8");
    return filePath;
  }
  const markerStart = "<!-- tokenopt:mcp-instructions:start -->";
  const markerEnd = "<!-- tokenopt:mcp-instructions:end -->";
  const block = `${markerStart}\n${snippet}\n${markerEnd}`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = existing.includes(markerStart) && existing.includes(markerEnd)
    ? existing.replace(new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`), block)
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(filePath, next, "utf8");
  return filePath;
}

export function buildInstructionGraph(repoRoot: string): InstructionGraphPlan {
  const files: InstructionGraphFile[] = [
    graphFile(path.join(repoRoot, ".github", "copilot-instructions.md"), rootInstructionGraphContent()),
    graphFile(path.join(repoRoot, ".github", "instructions", "tokenopt-review.instructions.md"), reviewInstructionGraphContent()),
    graphFile(path.join(repoRoot, ".github", "instructions", "tokenopt-runtime.instructions.md"), runtimeInstructionGraphContent()),
    graphFile(path.join(repoRoot, "AGENTS.md"), agentsInstructionGraphContent())
  ];
  const totalEstimatedTokens = files.reduce((sum, file) => sum + file.estimatedTokens, 0);
  const warnings = [
    totalEstimatedTokens > 2000 ? `Instruction graph is ${totalEstimatedTokens} estimated tokens; keep root instructions short and path-specific guidance scoped.` : undefined,
    ...files.flatMap((file) => file.estimatedTokens > 900 ? [`${path.relative(repoRoot, file.path)} is ${file.estimatedTokens} estimated tokens; consider shortening.`] : [])
  ].filter((warning): warning is string => Boolean(warning));
  return { files, totalEstimatedTokens, warnings };
}

export function formatInstructionGraphPlan(repoRoot: string, plan = buildInstructionGraph(repoRoot)): string {
  return [
    "TokenOpt instruction graph plan",
    `repo: ${repoRoot}`,
    `files: ${plan.files.length}`,
    `estimatedTokens: ${plan.totalEstimatedTokens}`,
    "",
    "Files:",
    ...plan.files.map((file) => `- ${path.relative(repoRoot, file.path)} (${file.estimatedTokens} est tokens)`),
    "",
    "Warnings:",
    ...(plan.warnings.length > 0 ? plan.warnings.map((warning) => `- ${warning}`) : ["- none"])
  ].join("\n");
}

export function buildNativePromptPack(repoRoot: string): NativePromptPackPlan {
  const files = TOKENOPT_NATIVE_PROMPTS.map((prompt) =>
    graphFile(path.join(repoRoot, ".github", "prompts", prompt.fileName), formatNativePromptFile(prompt))
  );
  return {
    files,
    totalEstimatedTokens: files.reduce((sum, file) => sum + file.estimatedTokens, 0)
  };
}

export function formatNativePromptPackPlan(repoRoot: string, plan = buildNativePromptPack(repoRoot)): string {
  return [
    "TokenOpt native prompt pack plan",
    `repo: ${repoRoot}`,
    `files: ${plan.files.length}`,
    `estimatedTokens: ${plan.totalEstimatedTokens}`,
    "",
    "Files:",
    ...plan.files.map((file) => `- ${path.relative(repoRoot, file.path)} (${file.estimatedTokens} est tokens)`)
  ].join("\n");
}

export function installNativePromptPack(repoRoot: string): string[] {
  const plan = buildNativePromptPack(repoRoot);
  const written: string[] = [];
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, `${file.content.trimEnd()}\n`, "utf8");
    written.push(file.path);
  }
  return written;
}

export function installInstructionGraph(repoRoot: string): string[] {
  const plan = buildInstructionGraph(repoRoot);
  const written: string[] = [];
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    if (path.basename(file.path) === "AGENTS.md" || path.basename(file.path) === "copilot-instructions.md") {
      writeMarkedInstructionBlock(file.path, file.content);
    } else {
      fs.writeFileSync(file.path, `${file.content.trimEnd()}\n`, "utf8");
    }
    written.push(file.path);
  }
  return written;
}

interface NativePromptTemplate {
  fileName: string;
  name: string;
  description: string;
  argumentHint: string;
  body: string[];
}

const TOKENOPT_NATIVE_PROMPTS: NativePromptTemplate[] = [
  {
    fileName: "pbi-plan.prompt.md",
    name: "pbi-plan",
    description: "Create a compatibility-preserving implementation plan from a concrete PBI or requirement.",
    argumentHint: "<paste PBI/requirement text, ticket URL, or acceptance criteria>",
    body: [
      "Create an implementation plan for the provided PBI/requirement while preserving compatibility. Return JSON.",
      "",
      "TokenOpt routing:",
      "- If no concrete PBI, requirement body, issue URL, or acceptance criteria is provided, do not explore the repo. Ask for the missing artifact in JSON.",
      "- If a concrete artifact is provided, use TokenOpt as a cost gate only when it can replace broad exploration.",
      "- Keep any followup exact and bounded.",
      "",
      "JSON keys: status, requirement_summary, impacted_areas, implementation_plan, tests, compatibility_risks, missing_items, next_steps."
    ]
  },
  {
    fileName: "requirement-analysis.prompt.md",
    name: "requirement-analysis",
    description: "Analyze a concrete requirement into WHAT, WHY, HOW, acceptance criteria, tests, and unknowns.",
    argumentHint: "<paste requirement text or ticket URL>",
    body: [
      "Analyze the provided requirement. Return JSON with WHAT, WHY, HOW, acceptance criteria, impacted areas, tests, and unknowns.",
      "",
      "TokenOpt routing:",
      "- If the requirement text or ticket URL is missing, do not inspect the repo. Return bounded JSON asking for the requirement artifact.",
      "- Do not invent repo-specific evidence when the requirement is absent.",
      "- When artifact exists, use TokenOpt only for broad repo evidence that replaces exploration.",
      "",
      "JSON keys: status, what, why, how, acceptance_criteria, impacted_areas, tests, unknowns, evidence_used."
    ]
  },
  {
    fileName: "write-unittest.prompt.md",
    name: "write-unittest",
    description: "Plan or write focused unit tests for a concrete class/module/behavior.",
    argumentHint: "<target class/module/file and behavior>",
    body: [
      "Plan or write focused unit tests for the provided target and behavior. Return JSON unless the user asks for code edits.",
      "",
      "TokenOpt routing:",
      "- Require a concrete target class, module, file, behavior, or failing case.",
      "- If the target is missing, do not search the repo to guess it. Ask for the target/behavior.",
      "- If the target exists and TokenOpt full-mode coding tools are available, use coding_coverage once.",
      "- For write_unittest, use at most one additional allowed MCP followup after compile_evidence.",
      "",
      "JSON keys: status, target, behavior, test_location, test_cases, fixtures_or_mocks, assertions, targeted_command, missing_items."
    ]
  },
  {
    fileName: "security-audit.prompt.md",
    name: "security-audit",
    description: "Run a security-focused review only when concrete diff/scope is provided.",
    argumentHint: "<diff, PR, changed files, route, symbol, or risky surface>",
    body: [
      "Perform a security-focused review of the provided changed behavior or risky surface. Return JSON findings.",
      "",
      "TokenOpt routing:",
      "- Use security_audit route.",
      "- Require concrete diff/scope before findings.",
      "- Security coverage must consider target/scope, input boundaries, auth/authz, validation/deserialization, secrets/config/dependencies, and tests/guardrails.",
      "- If scope is missing, do not broad-search. Ask for the diff, PR, changed files, route, symbol, or risky surface.",
      "- Use exact followups only; never use broad shell review fallback.",
      "",
      "JSON keys: status, findings, evidence_used, missing_coverage, non_findings, next_steps."
    ]
  },
  {
    fileName: "review-code.prompt.md",
    name: "review-code",
    description: "Review concrete code diffs with bounded evidence and compact findings.",
    argumentHint: "<diff, PR, changed files, or exact review target>",
    body: [
      "Review the provided code diff/scope. Prioritize correctness, regressions, missing tests, security, and performance. Return JSON findings.",
      "",
      "TokenOpt routing:",
      "- Diff-first and scope-first.",
      "- If no diff, PR, changed files, file path, symbol, or exact target is provided, do not explore the repo. Ask for the review artifact.",
      "- When concrete diff/scope exists, use review_diff evidence and exact bounded followups only.",
      "- Avoid style nits unless they affect behavior.",
      "",
      "JSON keys: status, findings, evidence_used, missing_scope, non_findings, suggested_tests."
    ]
  },
  {
    fileName: "promote-review-memory.prompt.md",
    name: "promote-review-memory",
    description: "Extract reusable review-memory candidates from completed task evidence.",
    argumentHint: "<completed task summary, transcript, diff, or review outcome>",
    body: [
      "Identify what should be promoted into review memory after a completed task. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Require completed-task evidence: summary, transcript, diff, review findings, or final outcome.",
      "- If completed-task evidence is missing, do not inspect the repo. Ask for that evidence.",
      "- Promote only stable, reusable facts. Avoid stale branch-specific details.",
      "",
      "JSON keys: status, memory_candidates, expiry_or_refresh, excluded_items, missing_items, rationale."
    ]
  }
];

function formatNativePromptFile(prompt: NativePromptTemplate): string {
  return [
    "---",
    `name: ${prompt.name}`,
    `description: ${JSON.stringify(prompt.description)}`,
    `argument-hint: ${JSON.stringify(prompt.argumentHint)}`,
    "agent: agent",
    "---",
    "",
    ...prompt.body
  ].join("\n");
}

function graphFile(filePath: string, content: string): InstructionGraphFile {
  return {
    path: filePath,
    content,
    estimatedTokens: estimateTokens(content.length)
  };
}

function rootInstructionGraphContent(): string {
  return [
    "# TokenOpt ContextGate",
    "",
    "Use TokenOpt as a selective context governor, not as MCP-first for every prompt.",
    "",
    "- Broad repo, business/domain, build handoff, flow, review diff, runtime debug, and refactor-scope tasks may use TokenOpt evidence first.",
    "- Missing-artifact PBI, requirement, unit-test, review-memory, or review prompts should ask for the concrete artifact instead of exploring.",
    "- Security audit requires concrete diff/scope and exact security followups only.",
    "- Exact file/class/method tasks and small-repo direct edits should use normal narrow search/read unless the user asks for TokenOpt.",
    "- Copilot prompt files under `.github/prompts` provide native slash prompts for common TokenOpt tasks.",
    "- If a packet says answerable=true, answer from it and avoid broad fallback.",
    "- For code changes, prefer unified diffs or compact edit plans instead of full-file rewrites."
  ].join("\n");
}

function reviewInstructionGraphContent(): string {
  return [
    "---",
    "applyTo: \"**/*.{java,ts,tsx,js,jsx,py,go,rs,kt,scala,cs}\"",
    "---",
    "",
    "# TokenOpt Review Tasks",
    "",
    "For PR/diff/code-review prompts, prefer task-shaped review evidence.",
    "",
    "- Use `tokenopt_compile_evidence` with `task_type=review_diff` when the prompt contains a concrete diff.",
    "- If the prompt has no diff, PR, changed files, file path, symbol, or exact target, ask for the review artifact and do not explore the repo.",
    "- For security review, require concrete scope and use exact security followups only.",
    "- In MCP full mode, use `tokenopt_prepare_java_diff` for Java diffs and `tokenopt_business_contract` for API/schema/security/messaging/test contracts.",
    "- Report compact findings with file, line, severity, evidence, and suggestion.",
    "- Do not spend tokens on import reorder, whitespace, or Lombok-only changes unless they affect compile/runtime behavior."
  ].join("\n");
}

function runtimeInstructionGraphContent(): string {
  return [
    "---",
    "applyTo: \"**/*.{java,xml,yml,yaml,properties,gradle}\"",
    "---",
    "",
    "# TokenOpt Runtime And Java Tasks",
    "",
    "- Compress Java stack traces and Maven/Gradle logs before carrying them forward.",
    "- Preserve Caused by chains, user-code frames, first framework boundary, failing tests, and final build stats.",
    "- In MCP full mode, use `tokenopt_jakarta_annotation_filter` for Lombok-heavy entities and `tokenopt_assemble_spring_context` for actuator/beans JSON.",
    "- Allow one exact follow-up when runtime evidence is incomplete; avoid broad repo search after an answerable packet."
  ].join("\n");
}

function agentsInstructionGraphContent(): string {
  return [
    "## TokenOpt ContextGate",
    "",
    "Use TokenOpt selectively. Broad/review/debug/refactor tasks can use evidence packets; exact direct-file tasks should stay narrow.",
    "Respect coverage certificates: if answerable=true and missing=[], answer without broad fallback.",
    "Use compact diffs/edit plans for code changes and keep output concise."
  ].join("\n");
}

function writeMarkedInstructionBlock(filePath: string, content: string): void {
  const markerStart = "<!-- tokenopt:instruction-graph:start -->";
  const markerEnd = "<!-- tokenopt:instruction-graph:end -->";
  const block = `${markerStart}\n${content.trimEnd()}\n${markerEnd}`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = existing.includes(markerStart) && existing.includes(markerEnd)
    ? existing.replace(new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`), block)
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(filePath, next, "utf8");
}

function instructionTargetPath(repoRoot: string, target: Exclude<InstructionTarget, "generic">): string {
  if (target === "copilot") {
    return path.join(repoRoot, ".github", "copilot-instructions.md");
  }
  if (target === "copilot-path") {
    return path.join(repoRoot, ".github", "instructions", "tokenopt.instructions.md");
  }
  if (target === "copilot-agent") {
    return path.join(repoRoot, ".github", "agents", "tokenopt-cost-gate.agent.md");
  }
  return path.join(repoRoot, "AGENTS.md");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findInstructionFiles(repoRoot: string): string[] {
  const candidates = [
    path.join(repoRoot, "AGENTS.md"),
    path.join(repoRoot, ".github", "copilot-instructions.md")
  ];
  const instructionDir = path.join(repoRoot, ".github", "instructions");
  if (fs.existsSync(instructionDir)) {
    for (const entry of fs.readdirSync(instructionDir)) {
      if (entry.endsWith(".instructions.md")) {
        candidates.push(path.join(instructionDir, entry));
      }
    }
  }
  const agentDir = path.join(repoRoot, ".github", "agents");
  if (fs.existsSync(agentDir)) {
    for (const entry of fs.readdirSync(agentDir)) {
      if (entry.endsWith(".agent.md")) {
        candidates.push(path.join(agentDir, entry));
      }
    }
  }
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function auditFile(filePath: string): AuditFile {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 12);
  const seen = new Set<string>();
  let duplicateLines = 0;
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      duplicateLines += 1;
    }
    seen.add(key);
  }

  return {
    path: filePath,
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text.length),
    duplicateLines,
    conflicts: detectConflicts(text)
  };
}

function detectConflicts(text: string): string[] {
  const conflicts: string[] = [];
  if (/\bnpm\b/i.test(text) && /\bpnpm\b/i.test(text)) {
    conflicts.push("Mentions both npm and pnpm; clarify package manager precedence.");
  }
  if (/\byarn\b/i.test(text) && /\bpnpm\b/i.test(text)) {
    conflicts.push("Mentions both yarn and pnpm; clarify package manager precedence.");
  }
  if (/never\s+use\s+tests?/i.test(text) && /run\s+tests?/i.test(text)) {
    conflicts.push("Contains both test avoidance and test-running guidance.");
  }
  return conflicts;
}

function formatAudit(audit: AuditFile, repoRoot: string): string[] {
  const rel = path.relative(repoRoot, audit.path) || audit.path;
  const warnings = [
    audit.estimatedTokens > 1500 ? "Large instruction file; consider path-specific split." : undefined,
    audit.duplicateLines > 0 ? `${audit.duplicateLines} duplicate-looking lines.` : undefined,
    ...audit.conflicts
  ].filter((item): item is string => Boolean(item));
  return [
    `- ${rel}`,
    `  bytes: ${audit.bytes}`,
    `  estimatedTokens: ${audit.estimatedTokens}`,
    `  findings: ${warnings.length > 0 ? warnings.join(" ") : "none"}`
  ];
}
