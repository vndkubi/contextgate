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
      "Native Copilot prompt files may also be installed under `.github/prompts`: `/trace-bug`, `/flow-trace`, `/write-unittest`, `/implement-feature`, `/pbi-plan`, `/requirement-analysis`, `/security-audit`, `/review-code`, `/performance-analysis`, `/dependency-analysis`, `/spec-feature-plan`, and more.",
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
    "If `.github/prompts` is installed, users may call native Copilot prompt files such as `/trace-bug`, `/flow-trace`, `/write-unittest`, `/implement-feature`, `/pbi-plan`, `/requirement-analysis`, `/security-audit`, `/review-code`, `/performance-analysis`, `/dependency-analysis`, `/spec-feature-plan`, or `/promote-review-memory`. Treat those prompt files as normal user intent plus the routing rules in this instruction file.",
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
    fileName: "business-deep-dive.prompt.md",
    name: "business-deep-dive",
    description: "Study a product, business, or domain area from repo evidence.",
    argumentHint: "<business area, domain term, product capability, or repo scope>",
    body: [
      "Study the provided business/domain area from repository evidence. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is usually a broad repo/domain task, so use TokenOpt as a cost gate when it can replace broad exploration.",
      "- If the requested area is named, require evidence tied to that target before answerable=true.",
      "- If exact line-level flow proof is needed, switch to native narrow search/read for that exact flow.",
      "",
      "JSON keys: status, business_summary, actors, concepts, glossary, flows, evidence_used, gaps, next_steps."
    ]
  },
  {
    fileName: "build-handoff.prompt.md",
    name: "build-handoff",
    description: "Create a build/onboarding/daily handoff grounded in repo facts.",
    argumentHint: "<optional target module or handoff focus>",
    body: [
      "Create a concise build/onboarding/daily handoff grounded in repository evidence. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is a broad repo handoff task; use tokenopt_compile_evidence once as a cost gate when available.",
      "- If answerable=true, answer from the packet and do not gather redundant repo facts.",
      "- Prefer copied package/build commands over inferred commands.",
      "",
      "JSON keys: status, build_system, package_manager, key_commands, repo_map, fast_validation, risks, evidence_used."
    ]
  },
  {
    fileName: "context-budget.prompt.md",
    name: "context-budget",
    description: "Inspect context budget risks and recommend compaction checkpoints.",
    argumentHint: "<optional workflow, task, or repo area>",
    body: [
      "Inspect context budget risks and recommend compaction/checkpoint strategy. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Use TokenOpt for broad repo shape and cost-risk evidence.",
      "- Do not read large raw files unless a concrete budget driver is named.",
      "- Recommend checkpoints based on evidence, not generic advice.",
      "",
      "JSON keys: status, budget_drivers, risky_workflows, compaction_checkpoints, reuse_candidates, missing_items, evidence_used."
    ]
  },
  {
    fileName: "dependency-analysis.prompt.md",
    name: "dependency-analysis",
    description: "Analyze dependency/build graph risks and targeted verification.",
    argumentHint: "<dependency, package, module, conflict, or build symptom>",
    body: [
      "Analyze dependency/build risks and propose targeted verification. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Use TokenOpt for broad build facts and dependency context when the target is not exact.",
      "- If a concrete dependency/config/file is named, use native narrow search/read around that artifact.",
      "- Avoid lockfile reads unless they are necessary for the stated dependency question.",
      "",
      "JSON keys: status, dependency_scope, build_files, risks, verification_commands, missing_items, evidence_used."
    ]
  },
  {
    fileName: "field-impact.prompt.md",
    name: "field-impact",
    description: "Analyze impact of changing a field, schema, property, or API contract.",
    argumentHint: "<field/schema/property/API name>",
    body: [
      "Analyze the impact of changing the provided field/schema/property/API contract. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is an exact impact task; prefer native narrow search/read around the named field or contract.",
      "- Use TokenOpt only for broad business/context summary if needed before exact impact work.",
      "- Cite producers, consumers, validation, persistence, API contracts, tests, and migration risks.",
      "",
      "JSON keys: status, target, producers, consumers, validation, persistence, api_contracts, tests, migration_risks, evidence_used."
    ]
  },
  {
    fileName: "flow-trace.prompt.md",
    name: "flow-trace",
    description: "Trace an exact code/API/business flow with line-level evidence.",
    argumentHint: "<flow name, endpoint, entrypoint, class, or behavior>",
    body: [
      "Trace the provided flow end to end and cite exact evidence. Return JSON unless the user asks for Mermaid.",
      "",
      "TokenOpt routing:",
      "- If the prompt names an entrypoint, endpoint, class, route, or exact behavior, use native narrow search/read directly.",
      "- Do not call ContextGate first for line-level flow proof; it usually double-spends.",
      "- If the owner is unknown and the task is broad flow discovery, use TokenOpt once, then exact followups only.",
      "",
      "JSON keys: status, acquisition_path, entrypoints, ordered_steps, files_and_symbols, unknown_edges, tests, evidence_used."
    ]
  },
  {
    fileName: "implement-feature.prompt.md",
    name: "implement-feature",
    description: "Implement or plan a concrete feature with targeted validation.",
    argumentHint: "<feature/PBI/spec text and optional target module>",
    body: [
      "Implement or plan the provided feature using the smallest safe change. Return JSON if planning; edit files only if explicitly asked.",
      "",
      "TokenOpt routing:",
      "- If the owning file/module is known, use native narrow search/read and targeted validation.",
      "- If the owning area is unknown and full-mode coding tools are available, use coding_coverage once.",
      "- Do not accept coding answerability without exact target, signature/definition, dependencies/usages, test neighbor/style, and build/test command.",
      "",
      "JSON keys: status, scope, target_files, implementation_steps, tests, validation, risks, missing_items."
    ]
  },
  {
    fileName: "onboarding-guide.prompt.md",
    name: "onboarding-guide",
    description: "Create a concise onboarding guide grounded in repo evidence.",
    argumentHint: "<optional audience or module>",
    body: [
      "Create a concise onboarding guide grounded in repository evidence. Return JSON sections and citations.",
      "",
      "TokenOpt routing:",
      "- This is a broad repo task; use TokenOpt as a cost gate for build facts, repo shape, docs, and quick validation.",
      "- Do not inspect exact source files unless the onboarding target names a specific module.",
      "- Prefer verified setup and test commands from repo files.",
      "",
      "JSON keys: status, audience, setup, repo_map, common_workflows, verification, risks, evidence_used."
    ]
  },
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
    fileName: "performance-analysis.prompt.md",
    name: "performance-analysis",
    description: "Analyze likely performance hotspots with measurement-first optimization guidance.",
    argumentHint: "<hotspot, workflow, query, endpoint, or module>",
    body: [
      "Analyze likely performance hotspots and propose measurement-first optimizations. Return JSON.",
      "",
      "TokenOpt routing:",
      "- If no hotspot/target is named, use TokenOpt for broad repo evidence and clearly mark hypotheses.",
      "- If an endpoint/query/module is named, use native narrow search/read around that exact path.",
      "- Do not propose fixes without measurement and targeted validation.",
      "",
      "JSON keys: status, target, suspected_hotspots, measurements, optimization_options, validation, risks, evidence_used."
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
    fileName: "refactor-scope.prompt.md",
    name: "refactor-scope",
    description: "Scope a refactor/migration with impacted usages, contracts, config, and tests.",
    argumentHint: "<symbol, API, migration, resource, package, or behavior>",
    body: [
      "Scope the provided refactor or migration. Return impacted definitions, usages, contracts, config, tests, and risks as JSON.",
      "",
      "TokenOpt routing:",
      "- If the refactor target is exact, use native narrow search/read for definitions and usages.",
      "- Use TokenOpt for broader impact planning only when it can replace repo-wide exploration.",
      "- Keep output as a plan unless the user explicitly asks for edits.",
      "",
      "JSON keys: status, target, definitions, usages, contracts, config, tests, migration_risks, validation_plan, evidence_used."
    ]
  },
  {
    fileName: "repo-benchmark-analysis.prompt.md",
    name: "repo-benchmark-analysis",
    description: "Analyze a repository as a benchmark target with cost and task-class risks.",
    argumentHint: "<optional benchmark focus>",
    body: [
      "Analyze this repository as a benchmark target: build facts, repo shape, likely task classes, and cost risks. Return JSON.",
      "",
      "TokenOpt routing:",
      "- This is a broad repo analysis task; use TokenOpt as a cost gate.",
      "- Do not enumerate all files in model context; rely on bounded inventory/facts.",
      "- Identify which task classes should use TokenOpt and which should bypass it.",
      "",
      "JSON keys: status, build_facts, repo_shape, likely_task_classes, cost_risks, benchmark_suggestions, evidence_used."
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
    fileName: "spec-autorun.prompt.md",
    name: "spec-autorun",
    description: "Plan a SpecKit /autorun workflow with bounded phases and evidence reuse.",
    argumentHint: "<spec, feature, or workflow goal>",
    body: [
      "Plan a SpecKit /autorun workflow with bounded phases, evidence reuse, and verification checkpoints. Return JSON.",
      "",
      "TokenOpt routing:",
      "- Use TokenOpt for broad planning only when it replaces exploration.",
      "- Split the work into bounded phases with clear stop/verify points.",
      "- Reuse evidence packets and avoid repeating the same searches across phases.",
      "",
      "JSON keys: status, phases, evidence_reuse, checkpoints, validation, stop_conditions, risks."
    ]
  },
  {
    fileName: "spec-feature-plan.prompt.md",
    name: "spec-feature-plan",
    description: "Specify or plan a feature from repo/domain evidence with acceptance criteria.",
    argumentHint: "<feature idea, spec text, or acceptance criteria>",
    body: [
      "Specify or plan the provided feature from repo/domain evidence and produce acceptance criteria. Return JSON.",
      "",
      "TokenOpt routing:",
      "- If feature/spec text is missing, ask for it instead of exploring.",
      "- If provided, use TokenOpt for broad repo/domain evidence and exact followups only for named targets.",
      "- Keep implementation, tests, validation, and unknowns explicit.",
      "",
      "JSON keys: status, feature_summary, domain_evidence, acceptance_criteria, implementation_outline, tests, unknowns, evidence_used."
    ]
  },
  {
    fileName: "startup-flow.prompt.md",
    name: "startup-flow",
    description: "Trace application startup/bootstrap flow or debug startup failure.",
    argumentHint: "<application/module, startup failure, stack trace, or config target>",
    body: [
      "Trace startup/bootstrap flow or debug the provided startup failure. Return JSON.",
      "",
      "TokenOpt routing:",
      "- For exact startup flow tracing with known entrypoint/config, use native narrow search/read.",
      "- For long stack traces/build logs, use tokenopt_failure_packet to extract exact files/lines before bounded reads.",
      "- If no startup artifact or target is provided, ask for entrypoint, config, stack trace, or failing command.",
      "",
      "JSON keys: status, acquisition_path, entrypoint, initialization_order, config_loading, failure_points, targeted_verification, evidence_used."
    ]
  },
  {
    fileName: "trace-bug.prompt.md",
    name: "trace-bug",
    description: "Trace an exact bug from concrete failure evidence using native narrow reads by default.",
    argumentHint: "<failing test, stack trace, error output, repro steps, file, class, function, or behavior>",
    body: [
      "Trace the provided bug using exact evidence. Return JSON.",
      "",
      "TokenOpt routing:",
      "- If a file, class, function, line, failing test, stack frame, or exact behavior is provided, use native narrow search/read directly.",
      "- Do not call ContextGate first for exact bug tracing; it usually double-spends.",
      "- If stack trace/build/test output is long, use tokenopt_failure_packet first, then narrow read the suggested slices.",
      "- If no concrete bug artifact is provided, ask for failing test, stack trace/error output, repro steps, expected vs actual behavior, or target symbol.",
      "",
      "JSON keys: status, acquisition_path, bug_summary, evidence_chain, suspected_root_cause, affected_files, targeted_fix_location, verification, missing_items."
    ]
  },
  {
    fileName: "review-code.prompt.md",
    name: "review-code",
    description: "Review concrete code diffs with bounded technical findings and business/test coverage gaps.",
    argumentHint: "<diff, PR, changed files, or exact review target>",
    body: [
      "Review the provided code diff/scope in two phases: technical review first, then business/edge-case/test-design coverage review. Return compact JSON.",
      "",
      "TokenOpt routing:",
      "- Diff-first and scope-first.",
      "- When TokenOpt MCP is available and the input has a concrete diff, PR, branch pair, changed files, file path, symbol, or exact review target, first call `tokenopt_compile_evidence` with `task_type=review_diff`, `cwd`, `budget_tokens` around 2200, and the full user request plus the complete net unified diff in `task`.",
      "- If the input is a PR number or URL, review the net PR diff and use the PR merge/head worktree as cwd before follow-up reads/searches.",
      "- If the input is a branch pair, treat the target branch as base and the feature/source branch as head; get the net diff from merge-base/base...head, then call `tokenopt_compile_evidence` before writing the review.",
      "- If the user provides Jira tickets or Confluence pages/URLs, use the available Jira/Confluence MCP tools to read the ticket/page and relevant attachments before the business/test coverage phase. Do not ask the user to paste the full ticket/page content when a connector can read it. Treat them as requirement evidence, not as a replacement for the code review artifact.",
      "- If Jira/Confluence MCP tools are unavailable or the ticket/page cannot be read, state this in `notes` and mark requirement-backed business coverage as missing or assumption-based.",
      "- If no diff, PR, changed files, file path, symbol, or exact target is provided, do not explore the repo. Ask for the review artifact.",
      "- When concrete diff/scope exists, use review_diff evidence and exact bounded followups only; do not review per-commit patch series as final state.",
      "- If TokenOpt MCP is unavailable, state that and proceed with native net-diff review.",
      "- Treat domain words like security, auth, privilege, or permission as code-review context unless the user explicitly asks for a security audit/review.",
      "- If the user provides a review checklist, preserve it as required review rubric and answer every checklist item.",
      "",
      "Technical review phase:",
      "- Report only introduced, actionable correctness, security, performance, reliability, compatibility, or maintainability defects.",
      "- If TokenOpt evidence includes recall_probe facts, adjudicate each checked probe as a technical finding, coverage gap, or explicit non-issue with contrary evidence. Promote P1/P2 technical_finding_candidate=true probes unless contrary evidence disproves them.",
      "- Before saying no findings, check changed invariants, effective config/policy math, parser/encoding boundaries, backward compatibility, concurrency/async behavior, resource lifecycle, null/error paths, and call replacements.",
      "- Do not downgrade a proven regression into a test gap.",
      "",
      "Business/test coverage phase:",
      "- Report non-blocking gaps separately from technical findings.",
      "- Ground requirement coverage in Jira/Confluence evidence, including ticket/page attachments when relevant, when the user provided those artifacts; otherwise mark requirement assumptions explicitly.",
      "- Apply ISTQB-style dimensions where relevant: boundary values, equivalence partitions, negative/error cases, state transitions, concurrency/async, and compatibility/backward compatibility.",
      "- Prefer exact tests tied to the changed behavior over broad test requests.",
      "- Avoid style nits unless they affect behavior.",
      "",
      "User checklist phase:",
      "- Return item-by-item checklist coverage as pass, fail, gap, or not_applicable with evidence or a short reason.",
      "- A checklist item becomes a technical finding only when the diff introduces an actionable defect; otherwise keep it in coverage/commentary.",
      "- Checklist scope does not suppress higher-severity defects found outside the checklist.",
      "",
      "JSON keys: technical_review, business_review, istqb_checks, user_checklist, review_status, evidence_contract_pass, acquisition_mode, notes."
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
    "- Exact bug traces with file/class/function/line/failing test/repro evidence should use native narrow search/read first; use `tokenopt_failure_packet` only for long failure output.",
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
    "For PR/diff/code-review prompts, prefer task-shaped review evidence and review in two phases: technical findings first, then business/test coverage gaps.",
    "",
    "- Use `tokenopt_compile_evidence` with `task_type=review_diff` when the prompt contains a concrete diff.",
    "- If the prompt references a PR, use the net PR diff and PR merge/head worktree for follow-up context. Do not treat per-commit patch output as the final review state.",
    "- If the prompt references a branch pair, treat target/base branch and feature/head branch as review scope, acquire the net merge-base diff, then call `tokenopt_compile_evidence` with the full diff in `task` before answering.",
    "- If the prompt includes Jira tickets or Confluence pages/URLs, use Jira/Confluence MCP tools to read the ticket/page and relevant attachments before business/test coverage review. Do not ask the user to paste full content when a connector can read it. If unavailable, state that requirement evidence is missing or assumption-based.",
    "- If the prompt has no diff, PR, changed files, file path, symbol, or exact target, ask for the review artifact and do not explore the repo.",
    "- For explicit security audit/review, require concrete scope and use exact security followups only. For normal code review, domain words such as security, auth, privilege, or permission do not by themselves switch to security_audit.",
    "- If the user provides a review checklist, preserve every item and return item-by-item coverage with pass, fail, gap, or not_applicable plus evidence.",
    "- In MCP full mode, use `tokenopt_prepare_java_diff` for Java diffs and `tokenopt_business_contract` for API/schema/security/messaging/test contracts.",
    "- Technical findings must be introduced, actionable defects with file, line, severity, evidence, and suggestion.",
    "- If TokenOpt evidence includes recall_probe facts, adjudicate each checked probe as a technical finding, coverage gap, or explicit non-issue with contrary evidence. Promote P1/P2 technical_finding_candidate=true probes unless contrary evidence disproves them.",
    "- Before returning no findings, check changed invariants, effective config/policy math, parser/encoding boundaries, backward compatibility, concurrency/async behavior, resource lifecycle, null/error paths, and call replacements.",
    "- Business/test coverage gaps must be separate from findings and should apply ISTQB dimensions: boundary values, equivalence partitions, negative/error cases, state transitions, concurrency/async, and compatibility/backward compatibility.",
    "- Do not downgrade a proven regression into a test gap.",
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
    "- Exact trace-bug tasks with a named file, class, function, line, failing test, stack frame, or repro path should use native narrow search/read directly.",
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
