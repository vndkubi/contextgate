import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./log-compressor.js";

export type InstructionTarget = "agents" | "codex" | "copilot" | "generic";

interface AuditFile {
  path: string;
  bytes: number;
  estimatedTokens: number;
  duplicateLines: number;
  conflicts: string[];
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
  const heading =
    target === "copilot"
      ? "# TokenOpt MCP Usage"
      : "## TokenOpt MCP Usage";
  return [
    heading,
    "",
    "When the TokenOpt MCP server is available, use it as the first context acquisition path for repository understanding, daily handoff, investigation, implementation planning, and unit-test planning tasks.",
    "",
    "Required first step:",
    "",
    "```text",
    "Call tokenopt_compile_evidence with:",
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
    "- Do not call shell, search, read_file, project_facts, or more MCP tools just to verify the same evidence.",
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
    "Prefer tokenopt_compile_evidence over raw shell exploration.",
    "Use tokenopt_search only for exact patterns and narrow paths.",
    "Use tokenopt_read_file only for bounded slices around exact matches.",
    "Use tokenopt_run_command for builds/tests so raw output is archived and model-visible output stays compact.",
    "Do not bypass TokenOpt with shell fallback after an answerable packet.",
    "```",
    "",
    "Daily task mapping:",
    "",
    "```text",
    "Build or onboarding handoff -> task_type=build_handoff",
    "Debugging, triage, why something fails -> task_type=investigate",
    "Business/product/domain research -> task_type=research_business",
    "Implementation planning or small code change -> task_type=implement",
    "Unit-test planning or test-writing task -> task_type=write_unittest",
    "API/endpoint flow -> task_type=api_flow",
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

function instructionTargetPath(repoRoot: string, target: Exclude<InstructionTarget, "generic">): string {
  if (target === "copilot") {
    return path.join(repoRoot, ".github", "copilot-instructions.md");
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
