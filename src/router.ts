import type { EvidenceTaskType, RouteDecision, TaskClass, ToolProfile } from "./types.js";

export interface RouteTaskInput {
  task: string;
  repoFileCount?: number;
  requestedTaskType?: EvidenceTaskType;
}

const SMALL_REPO_FILE_LIMIT = 250;
const GENERIC_SYMBOL_SIGNALS = new Set([
  "Benchmark",
  "JSON",
  "Project",
  "Repository",
  "Router",
  "TokenOpt"
]);

export function routeTask(input: RouteTaskInput): RouteDecision {
  const task = input.task.trim();
  const signals = collectPromptSignals(task);
  const prompt = task.toLowerCase();
  const hasExactFileTarget = signals.some((signal) => signal.startsWith("file:"));
  const hasExactSymbolTarget = signals.some((signal) => signal.startsWith("symbol:"));
  const hasExactTarget = hasExactFileTarget || hasExactSymbolTarget;
  const requestedTaskType = input.requestedTaskType && input.requestedTaskType !== "unknown" ? input.requestedTaskType : undefined;
  const missingArtifactReason = getMissingArtifactReason(task, prompt, signals);

  if (isSecurityAuditPrompt(prompt)) {
    return decision("security_audit", "review_diff", "security", "compile", [
      missingArtifactReason ?? "Prompt is security-audit oriented; require explicit security coverage before answerability.",
      ...(missingArtifactReason ? ["artifact:missing"] : []),
      ...signals
    ]);
  }

  if (missingArtifactReason) {
    return decision("needs_input_bypass", missingArtifactTaskType(task, prompt, requestedTaskType), "bypass", "bypass", [
      missingArtifactReason,
      "artifact:missing",
      ...signals
    ]);
  }

  if ((input.repoFileCount ?? Number.MAX_SAFE_INTEGER) < SMALL_REPO_FILE_LIMIT && hasExactFileTarget && !isReviewPrompt(prompt)) {
    return decision("small_repo_bypass", requestedTaskType ?? "field_impact", "bypass", "bypass", [
      "Small repository with an exact file or symbol target; generic evidence compilation is likely overhead.",
      ...signals
    ]);
  }

  if (isReviewPrompt(prompt)) {
    return decision("review_diff", "review_diff", "review", "compile", [
      "Prompt is review/diff oriented; use review-shaped evidence and avoid repo-wide exploration.",
      ...signals
    ]);
  }

  if (isCodingCoveragePrompt(task, requestedTaskType)) {
    return decision("coding_coverage", requestedTaskType ?? inferCodingTaskType(task), "coding", "compile", [
      "Prompt is a coding task; require symbol/test/failure coverage before answerability.",
      ...signals
    ]);
  }

  if (/\b(stack trace|exception|failing test|build failure|runtime|root cause|diagnose|debug|caused by)\b/i.test(task)) {
    return decision("debug_runtime", requestedTaskType ?? "investigate", "debug", "compile", [
      "Prompt is runtime/debug oriented; preserve failure slices and allow exact fallback for missing frames.",
      ...signals
    ]);
  }

  if (/\b(refactor|rename|move|extract|split|migrate)\b/i.test(task)) {
    return decision("refactor_scope", requestedTaskType ?? "implement", "refactor", "compile", [
      "Prompt is refactor/change-scope oriented; gather impact evidence and prefer diff output.",
      ...signals
    ]);
  }

  if (/\b(find usages|where defined|who calls|callers|references|definition|impact of)\b/i.test(task) || hasExactTarget) {
    return decision("exact_symbol", requestedTaskType ?? "field_impact", "exact", "exact_route", [
      "Prompt asks for exact symbol or file impact; use targeted search/read instead of generic MCP-first.",
      ...signals
    ]);
  }

  const taskType = requestedTaskType ?? inferBroadTaskType(task);
  return decision("broad_flow", taskType, "explore", "compile", [
    "Prompt needs broad repository context; compile a compact evidence packet before further exploration.",
    ...signals
  ]);
}

export function taskClassFromTaskType(taskType: EvidenceTaskType): TaskClass {
  switch (taskType) {
    case "review_diff":
      return "review_diff";
    case "api_flow":
    case "startup_flow":
    case "research_business":
    case "build_handoff":
      return "broad_flow";
    case "field_impact":
      return "exact_symbol";
    case "implement":
    case "write_unittest":
      return "coding_coverage";
    case "investigate":
      return "debug_runtime";
    default:
      return "broad_flow";
  }
}

function decision(
  taskClass: TaskClass,
  taskType: EvidenceTaskType,
  toolProfile: ToolProfile,
  action: RouteDecision["action"],
  reasons: string[]
): RouteDecision {
  const confidence = taskClass === "broad_flow"
    ? 0.72
    : taskClass === "small_repo_bypass" || taskClass === "needs_input_bypass"
      ? 0.88
      : taskClass === "coding_coverage"
        ? 0.84
        : 0.82;
  return {
    taskClass,
    taskType,
    toolProfile,
    action,
    reason: reasons[0] ?? "Route selected by prompt heuristics.",
    confidence,
    promptSignals: reasons.slice(1, 12),
    negativeControl: taskClass === "small_repo_bypass" || taskClass === "exact_symbol" || taskClass === "needs_input_bypass"
  };
}

function getMissingArtifactReason(task: string, prompt: string, signals: string[]): string | undefined {
  if (hasConcreteArtifact(task, signals)) {
    return undefined;
  }
  if (isPromoteReviewMemoryPrompt(prompt)) {
    return "Prompt asks to promote review memory but no completed-task summary, transcript, diff, or review evidence was provided.";
  }
  if (isUnitTestPlanningPrompt(prompt)) {
    return "Prompt asks for a unit-test plan but no target class, module, file, behavior, or failing case was provided.";
  }
  if (isPbiOrRequirementPlanPrompt(prompt)) {
    return "Prompt asks for a PBI/requirement implementation plan but no concrete PBI, requirement body, issue, or acceptance criteria was provided.";
  }
  if (isRequirementAnalysisPrompt(prompt)) {
    return "Prompt asks to analyze a requirement but no requirement text, ticket, or acceptance criteria was provided.";
  }
  if (isReviewPrompt(prompt)) {
    return "Prompt asks for review but no concrete diff, changed file list, PR, symbol, or risky surface was provided.";
  }
  return undefined;
}

function hasConcreteArtifact(task: string, signals: string[]): boolean {
  if (signals.some((signal) => signal.startsWith("file:") || signal.startsWith("symbol:") || signal === "diff:inline")) {
    return true;
  }
  return /https?:\/\/\S+/i.test(task) ||
    /\b(?:PBI|PB|REQ|ISSUE|BUG|TASK|JIRA|GH|PR)[-_]?\d+\b/i.test(task) ||
    /#\d{2,}\b/.test(task) ||
    /\b(?:requirement|pbi|acceptance criteria|completed task|task summary|transcript|diff|changed files?|risky surface|behavior)\s*:\s*\S.{20,}/is.test(task) ||
    /```[\s\S]{20,}```/.test(task) ||
    /[`"'][^`"']{20,}[`"']/.test(task);
}

function missingArtifactTaskType(task: string, prompt: string, requestedTaskType?: EvidenceTaskType): EvidenceTaskType {
  if (requestedTaskType) {
    return requestedTaskType;
  }
  if (isUnitTestPlanningPrompt(prompt)) {
    return "write_unittest";
  }
  if (isPbiOrRequirementPlanPrompt(prompt)) {
    return "implement";
  }
  if (isReviewPrompt(prompt)) {
    return "review_diff";
  }
  if (/\b(build|handoff|onboard)\b/i.test(task)) {
    return "build_handoff";
  }
  return "investigate";
}

function isSecurityAuditPrompt(prompt: string): boolean {
  return /\b(security|vulnerab|exploit|authn|authz|authorization|authentication|permission|secret|csrf|xss|sql injection|deseriali[sz]ation)\b/i.test(prompt) &&
    /\b(review|audit|findings?|risky surfaces?|changed behavior)\b/i.test(prompt);
}

function isPromoteReviewMemoryPrompt(prompt: string): boolean {
  return /\b(promote|promotion)\b/i.test(prompt) && /\b(review memory|memory)\b/i.test(prompt);
}

function isUnitTestPlanningPrompt(prompt: string): boolean {
  return /\b(unit tests?|unittest|write tests?|add tests?|test plan|test strategy)\b/i.test(prompt);
}

function isPbiOrRequirementPlanPrompt(prompt: string): boolean {
  return /\b(?:pbi|requirement)\b/i.test(prompt) && /\b(?:implementation plan|implement|preserving compatibility|compatibility)\b/i.test(prompt);
}

function isRequirementAnalysisPrompt(prompt: string): boolean {
  return /\banaly[sz]e\b/i.test(prompt) && /\brequirement\b/i.test(prompt);
}

function isCodingCoveragePrompt(task: string, requestedTaskType?: EvidenceTaskType): boolean {
  if (requestedTaskType === "implement" || requestedTaskType === "write_unittest") {
    return true;
  }
  return /\b(unit tests?|unittest|write tests?|add tests?|test coverage|implement|add feature|code change|modify|patch|fix bug|bugfix|fix failing|failing test|stack trace|exception|traceback|build failure|compilation error|debug|root cause|caused by)\b/i.test(task);
}

function inferCodingTaskType(task: string): EvidenceTaskType {
  if (/\b(unit tests?|unittest|write tests?|add tests?|test coverage)\b/i.test(task)) {
    return "write_unittest";
  }
  if (/\b(stack trace|exception|traceback|build failure|compilation error|debug|root cause|caused by|fix bug|bugfix|fix failing|failing test)\b/i.test(task)) {
    return "investigate";
  }
  return "implement";
}

function collectPromptSignals(task: string): string[] {
  const signals: string[] = [];
  for (const match of task.matchAll(/\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala|xml|json|ya?ml|md)\b/g)) {
    signals.push(`file:${match[0].replace(/\\/g, "/")}`);
  }
  for (const match of task.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/g)) {
    const symbol = match[0];
    if (GENERIC_SYMBOL_SIGNALS.has(symbol)) {
      continue;
    }
    if (symbol.includes(".") || /(?:Service|Controller|Repository|Gateway|Manager|Client|Factory|Handler|Config|Test|Exception|Error)$/.test(symbol)) {
      signals.push(`symbol:${symbol}`);
    }
  }
  if (/^diff --git\b/m.test(task) || /^@@\s/m.test(task)) {
    signals.push("diff:inline");
  }
  if (/\b(PR|pull request|changed files?)\b/i.test(task)) {
    signals.push("review:changed-files");
  }
  return [...new Set(signals)].slice(0, 16);
}

function isReviewPrompt(prompt: string): boolean {
  return /\b(review|pull request|pr|diff|changed files?|code review)\b/i.test(prompt) || /^diff --git\b/m.test(prompt);
}

function inferBroadTaskType(task: string): EvidenceTaskType {
  if (/\b(unit test|unittest|write test|add test|test plan|test strategy)\b/i.test(task)) {
    return "write_unittest";
  }
  if (/\b(business|product|domain|customer|research|purpose|what does this repo do)\b/i.test(task)) {
    return "research_business";
  }
  if (/\b(flow|sequence\s*diagram|flowchart|diagram|mermaid|end-to-end|e2e|journey|api|endpoint|route)\b/i.test(task)) {
    return "api_flow";
  }
  if (/\b(build|test|compile|gradle|maven|npm|package|version|wrapper|onboard|handoff|daily task)\b/i.test(task)) {
    return "build_handoff";
  }
  if (/\b(implement|change|add feature|modify|patch|code change)\b/i.test(task)) {
    return "implement";
  }
  if (/\b(investigate|debug|diagnose|root cause|why|triage)\b/i.test(task)) {
    return "investigate";
  }
  return "investigate";
}
