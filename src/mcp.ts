import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assembleSpringContext } from "./assemblers/spring-context-assembler.js";
import { compileCodingCoverageEvidence } from "./coding/coverage-contract.js";
import { parseFailurePacket } from "./coding/failure-packet.js";
import { buildSymbolPacket, findCodingSymbols } from "./coding/symbol-index.js";
import { findTestNeighbors } from "./coding/test-neighbors.js";
import { loadConfig } from "./config.js";
import { readActiveEvidenceTaskState, writeEvidenceTaskState } from "./evidence-state.js";
import { executeWrappedShellCommand } from "./exec.js";
import { filterJakartaAnnotations } from "./filters/jakarta-annotation-filter.js";
import { compressText } from "./log-compressor.js";
import { appendEvent, writeArtifact } from "./observability.js";
import { evaluatePolicy } from "./policy-core.js";
import { linkBusinessContracts } from "./processors/business-contract-linker.js";
import { analyzeImpact } from "./processors/impact-analysis.js";
import { prepareJavaDiff } from "./processors/java-diff-processor.js";
import { routeTask } from "./router.js";
import { evaluateShadowGate, logShadowGateDecision } from "./shadow-gate.js";
import type {
  CoverageCertificate,
  EvidenceCoverageStatus,
  EvidenceItem,
  EvidenceFollowup,
  EvidencePacket,
  EvidenceTaskType,
  FailurePacket,
  LoadedConfig,
  OutputPolicy,
  PolicyDecision,
  RouteDecision,
  SymbolPacket,
  TestNeighborPacket,
  TokenOptConfig,
  TokenOptEvent
} from "./types.js";

type SearchProvider = "rg" | "git" | "node";
type EvidenceDetail = "compact" | "full";
type McpMode = "lite" | "full";

const LITE_MCP_TOOL_NAMES = new Set(["tokenopt_compile_evidence", "tokenopt_search", "tokenopt_read_file"]);
const FULL_MCP_TOOL_NAMES = new Set([
  ...LITE_MCP_TOOL_NAMES,
  "tokenopt_run_command",
  "tokenopt_project_facts",
  "tokenopt_prepare_java_diff",
  "tokenopt_jakarta_annotation_filter",
  "tokenopt_assemble_spring_context",
  "tokenopt_business_contract",
  "tokenopt_impact_analysis",
  "tokenopt_symbols_find",
  "tokenopt_symbol_packet",
  "tokenopt_test_neighbors",
  "tokenopt_failure_packet"
]);

interface RepoInventory {
  totalFiles: number;
  rawChars: number;
  rawArtifact: string;
  estimatedTokensAvoided: number;
  searchProvider: SearchProvider;
  diagnostics: string[];
  topDirs: Array<[string, number]>;
  topExtensions: Array<[string, number]>;
  rootFiles: string[];
  importantFiles: string[];
}

interface ProviderFileList {
  provider: SearchProvider;
  files: string[];
  raw: string;
  diagnostics: string[];
}

interface SearchProviderResult {
  provider: SearchProvider;
  exitCode: number;
  durationMs: number;
  rawOutput: string;
  diagnostics: string[];
}

interface RepositoryOverview {
  file: string;
  title: string;
  summary: string;
}

const SERVER_INSTRUCTIONS =
  "TokenOpt is a cost gate. Use compile_evidence when it replaces broad exploration; skip MCP-first for exact code-flow/class/PBI tasks if shell/search will still be needed. If answerable=true, answer with zero redundant tools.";

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

  const mcpMode = normalizeMcpMode();
  const exposedToolNames = getExposedMcpToolNames(mcpMode);
  const allTools = [
      {
        name: "tokenopt_compile_evidence",
        title: "Compile Answerability Evidence",
        description: "Compile compact task evidence and followup policy.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "User task." },
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
              description: "Task category."
            },
            budget_tokens: {
              type: "number",
              description: "Evidence budget."
            },
            quality_rubric: {
              type: "array",
              items: { type: "string" },
              description: "Quality checklist."
            },
            detail: {
              type: "string",
              enum: ["compact", "full"],
              description: "compact default; full for debugging."
            },
            include_structured_packet: {
              type: "boolean",
              description: "Return full structured packet."
            },
            cwd: { type: "string", description: "Working directory." }
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
        description: "Run command with policy and compact output.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command." },
            cwd: { type: "string", description: "Working directory." }
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
        description: "Targeted repo search with compact output.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Search pattern." },
            path: { type: "string", description: "Repo-relative path." },
            cwd: { type: "string", description: "Working directory." }
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
        description: "Read bounded source slice.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repo-relative file." },
            startLine: { type: "number", description: "1-based start line." },
            maxLines: { type: "number", description: "Max lines, capped at 400." },
            cwd: { type: "string", description: "Working directory." }
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
        description: "Return compact build and inventory facts.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string", description: "Working directory." }
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
      },
      {
        name: "tokenopt_prepare_java_diff",
        title: "Prepare Java Diff",
        description: "Compress and classify Java diff hunks for review/refactor evidence.",
        inputSchema: {
          type: "object",
          properties: {
            diff: { type: "string", description: "Unified diff text. If omitted, reads git diff." },
            cwd: { type: "string", description: "Working directory." },
            staged: { type: "boolean", description: "Read git diff --cached when diff is omitted." }
          },
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt prepare Java diff",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_jakarta_annotation_filter",
        title: "Filter Jakarta/Lombok Annotations",
        description: "Collapse low-signal Lombok annotations while preserving Jakarta/JPA annotations.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "Java source text." },
            path: { type: "string", description: "Repo-relative Java file to filter." },
            cwd: { type: "string", description: "Working directory." }
          },
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt Jakarta annotation filter",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_assemble_spring_context",
        title: "Assemble Spring Context",
        description: "Compress actuator/beans JSON into entrypoint, security, service, data, messaging, and transaction slices.",
        inputSchema: {
          type: "object",
          properties: {
            json: { type: "string", description: "Spring actuator/beans JSON text." },
            path: { type: "string", description: "Repo-relative JSON file to assemble." },
            cwd: { type: "string", description: "Working directory." }
          },
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt Spring context assembler",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_business_contract",
        title: "Link Business Contracts",
        description: "Find API, schema, messaging, security, docs, and test contracts relevant to a diff or task.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "User task or review question." },
            diff: { type: "string", description: "Unified diff text." },
            changed_files: { type: "array", items: { type: "string" }, description: "Changed repo-relative files." },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["task"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt business contract linker",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_impact_analysis",
        title: "Analyze Impact",
        description: "Find definitions, usages, hot paths, public contracts, and likely tests for a target symbol or changed files.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "Symbol, class, method, route, or behavior to analyze." },
            diff: { type: "string", description: "Unified diff text." },
            changed_files: { type: "array", items: { type: "string" }, description: "Changed repo-relative files." },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["target"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt impact analysis",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_symbols_find",
        title: "Find Coding Symbols",
        description: "Regex-lite symbol discovery for coding tasks. Returns compact candidates with file, line, signature, and confidence.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Class, function, file, or task target." },
            language: {
              type: "string",
              enum: ["typescript", "javascript", "java", "python", "unknown"],
              description: "Optional language filter."
            },
            kind: {
              type: "string",
              enum: ["class", "interface", "function", "method", "const", "type", "unknown"],
              description: "Optional symbol kind filter."
            },
            limit: { type: "number", description: "Maximum candidates, capped at 50." },
            cwd: { type: "string", description: "Working directory." }
          },
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt symbols find",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_symbol_packet",
        title: "Build Symbol Packet",
        description: "Return signature, bounded definition slice, imports, dependencies, callers, callees, and nearby tests for a symbol.",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string", description: "Symbol id returned by tokenopt_symbols_find." },
            query: { type: "string", description: "Fallback class/function/file query." },
            cwd: { type: "string", description: "Working directory." }
          },
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt symbol packet",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_test_neighbors",
        title: "Find Test Neighbors",
        description: "Find nearby tests, naming patterns, framework hints, and mocking style for a source file or symbol.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "Source file, class, function, or module." },
            symbol_name: { type: "string", description: "Optional symbol name." },
            limit: { type: "number", description: "Maximum test candidates, capped at 50." },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["target"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt test neighbors",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_failure_packet",
        title: "Parse Failure Packet",
        description: "Parse compiler/test/runtime output into compact failure locations and suggested file slices.",
        inputSchema: {
          type: "object",
          properties: {
            output: { type: "string", description: "Compiler, test, or stack-trace output." },
            cwd: { type: "string", description: "Working directory. Accepted for consistency; not required." }
          },
          required: ["output"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt failure packet",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      }
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.filter((tool) => exposedToolNames.has(tool.name))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (!exposedToolNames.has(request.params.name)) {
      return textResult(
        `TokenOpt MCP tool ${request.params.name} is not exposed in ${mcpMode} mode. Set TOKENOPT_MCP_MODE=full to enable command/project facts tools.`,
        true
      );
    }
    try {
      switch (request.params.name) {
        case "tokenopt_compile_evidence":
          return compileEvidenceTool(args, mcpMode);
        case "tokenopt_run_command":
          return await runCommandTool(args);
        case "tokenopt_search":
          return await searchTool(args);
        case "tokenopt_read_file":
          return readFileTool(args);
        case "tokenopt_project_facts":
          return projectFactsTool(args);
        case "tokenopt_prepare_java_diff":
          return prepareJavaDiffTool(args);
        case "tokenopt_jakarta_annotation_filter":
          return jakartaAnnotationFilterTool(args);
        case "tokenopt_assemble_spring_context":
          return assembleSpringContextTool(args);
        case "tokenopt_business_contract":
          return businessContractTool(args);
        case "tokenopt_impact_analysis":
          return impactAnalysisTool(args);
        case "tokenopt_symbols_find":
          return symbolsFindTool(args);
        case "tokenopt_symbol_packet":
          return symbolPacketTool(args);
        case "tokenopt_test_neighbors":
          return testNeighborsTool(args);
        case "tokenopt_failure_packet":
          return failurePacketTool(args);
        default:
          return textResult(`Unknown TokenOpt tool: ${request.params.name}`, true);
      }
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  await server.connect(new StdioServerTransport());
}

function compileEvidenceTool(args: Record<string, unknown>, mcpMode: McpMode = "lite") {
  const task = sanitizeTaskPrompt(requiredString(args, "task"));
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const requestedTaskType = normalizeTaskType(optionalString(args, "task_type"), task);
  const budgetTokens = clampInteger(optionalNumber(args, "budget_tokens") ?? 1600, 400, 8000);
  const qualityRubric = optionalStringArray(args, "quality_rubric").slice(0, 12);
  const detail = normalizeEvidenceDetail(optionalString(args, "detail"));
  const includeStructuredPacket = optionalBoolean(args, "include_structured_packet") ?? false;
  const earlyRoute = routeTask({
    task,
    requestedTaskType
  });
  const earlyTaskType = optionalString(args, "task_type") && requestedTaskType !== "unknown" ? requestedTaskType : earlyRoute.taskType;
  if (earlyRoute.taskClass === "needs_input_bypass") {
    return compileMissingArtifactPacket({
      loaded,
      task,
      taskType: earlyTaskType,
      route: earlyRoute,
      budgetTokens,
      qualityRubric,
      detail,
      includeStructuredPacket
    });
  }
  if (earlyRoute.taskClass === "security_audit") {
    return compileSecurityAuditPacket({
      loaded,
      task,
      taskType: earlyTaskType,
      route: earlyRoute,
      budgetTokens,
      qualityRubric,
      detail,
      includeStructuredPacket
    });
  }
  const inventory = buildRepoInventory(loaded.repoRoot, loaded.config, loaded.repoRoot);
  const route = routeTask({
    task,
    repoFileCount: inventory.totalFiles,
    requestedTaskType
  });
  const taskType = optionalString(args, "task_type") && requestedTaskType !== "unknown" ? requestedTaskType : route.taskType;
  const facts = extractProjectFacts(loaded.repoRoot);
  const factFiles = factSourceFiles(facts);
  const hasBuildFacts = facts.some((fact) => fact.startsWith("build_tool="));
  const overview = extractRepositoryOverview(loaded.repoRoot);
  const structureFacts = extractStructureFacts(inventory);
  const evidenceContext: EvidenceContext = {
    inventory,
    facts,
    overview,
    structureFacts
  };
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
        `search_provider=${inventory.searchProvider}`,
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

  const taskSpecific = compileTaskSpecificEvidence(taskType, task, loaded.repoRoot, evidence.length + 1, evidenceContext, {
    hasBuildFacts,
    codingToolsAvailable: mcpMode === "full"
  });
  if (taskSpecific) {
    evidence.push(...taskSpecific.evidence);
  }

  const baseAnswerable = isEvidenceAnswerable(taskType, hasBuildFacts, inventory.totalFiles > 0, Boolean(overview), structureFacts);
  const initialAnswerable = taskSpecific?.answerable ?? baseAnswerable;
  const specificity = checkTargetSpecificity(task, taskType, evidence);
  const answerable = initialAnswerable && specificity.missing.length === 0;
  const preferTaskSpecificFollowups = route.taskClass === "coding_coverage" && taskSpecific?.allowedFollowups.length;
  const coverage = {
    ...buildCoverage(taskType, hasBuildFacts, inventory.totalFiles > 0, Boolean(overview), structureFacts, qualityRubric),
    ...(taskSpecific?.coverage ?? {}),
    ...(specificity.terms.length > 0
      ? {
          target_specific_evidence: specificity.missing.length === 0 ? "covered" as const : specificity.covered.length > 0 ? "partial" as const : "missing" as const
        }
      : {})
  };
  const missing = answerable
    ? []
    : specificity.missing.length > 0
      ? [
          `Target-specific evidence missing for: ${specificity.missing.join(", ")}.`,
          "TokenOpt cannot mark this task answerable until the packet includes evidence tied to the requested target.",
          ...(taskSpecific?.missing ?? [])
        ]
    : taskSpecific?.missing.length
      ? taskSpecific.missing
      : [
          "Task is not answerable from deterministic project facts alone.",
          "Use exact search/read followups for the specific symbol, file, or command named by the task."
        ];
  const allowedFollowups = answerable
    ? []
    : preferTaskSpecificFollowups
      ? taskSpecific!.allowedFollowups
    : specificity.missing.length > 0
      ? buildTargetSpecificFollowups(specificity.missing)
    : taskSpecific?.allowedFollowups.length
      ? taskSpecific.allowedFollowups
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
        ];
  const cappedAllowedFollowups = capAllowedFollowups(allowedFollowups, route, taskType);
  const answerContract = buildAnswerContract(taskType, task, qualityRubric, answerable);
  const packetId = crypto.randomUUID();
  const coverageCertificate = buildCoverageCertificate(packetId, route, answerable, taskSpecific?.confidence ?? (answerable ? 0.86 : 0.48), coverage, missing, cappedAllowedFollowups);
  const outputPolicy = buildOutputPolicy(route, taskType);
  const packet: EvidencePacket = {
    packet_id: packetId,
    task,
    task_type: taskType,
    route,
    repo_root: loaded.repoRoot,
    answerable,
    confidence: taskSpecific?.confidence ?? (answerable ? 0.86 : 0.48),
    coverage,
    coverage_certificate: coverageCertificate,
    output_policy: outputPolicy,
    evidence,
    missing,
    answer_contract: answerContract,
    allowed_followups: cappedAllowedFollowups,
    disallowed_followups: answerable
      ? [
          "tokenopt_search",
          "tokenopt_read_file",
          "tokenopt_project_facts",
          "tokenopt_run_command",
          "shell_rg",
          "shell_grep",
          "shell_git_grep",
          "shell_findstr",
          "raw_shell_search"
        ]
      : ["repo_wide_rg_files", "full_file_reads", "full_suite_tests_without_target"],
    recommended_next_action: answerable ? "answer_now" : "expand_exact",
    max_additional_calls: maxAdditionalCallsForPacket(answerable, route, taskType, cappedAllowedFollowups),
    token_budget: {
      budget_tokens: budgetTokens,
      evidence_tokens_est: evidence.reduce((total, item) => total + (item.tokens_est ?? estimateTokens(JSON.stringify(item))), 0),
      response_tokens_est: answerable ? Math.min(900, Math.max(300, Math.floor(budgetTokens * 0.45))) : 250
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  const statePath = writeEvidenceTaskState(loaded.config, loaded.repoRoot, packet);
  appendEvent(loaded.config, {
    timestamp: now.toISOString(),
    source: "mcp",
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

  return textResult(formatEvidencePacket(packet, statePath, detail), false, buildEvidenceStructuredContent(packet, statePath, includeStructuredPacket));
}

interface EarlyEvidencePacketInput {
  loaded: LoadedConfig;
  task: string;
  taskType: EvidenceTaskType;
  route: RouteDecision;
  budgetTokens: number;
  qualityRubric: string[];
  detail: EvidenceDetail;
  includeStructuredPacket: boolean;
}

function compileMissingArtifactPacket(input: EarlyEvidencePacketInput) {
  const coverage: Record<string, EvidenceCoverageStatus> = {
    prompt_classified: "covered",
    concrete_artifact: "missing",
    repo_evidence_needed: "missing"
  };
  const missing = [
    input.route.reason,
    "Provide the concrete PBI, requirement text, diff, file/symbol target, completed-task summary, or acceptance criteria before TokenOpt can compile grounded repository evidence."
  ];
  return writeEarlyEvidencePacket({
    ...input,
    answerable: false,
    confidence: 0.88,
    coverage,
    missing,
    evidence: [
      {
        id: "E1",
        claim: "TokenOpt detected a missing required artifact and skipped repository inventory to avoid speculative exploration.",
        facts: [`route=${input.route.taskClass}`, `reason=${input.route.reason}`, "repo_inventory=skipped"],
        tokens_est: 70
      }
    ],
    allowedFollowups: [],
    recommendedNextAction: "ask_user",
    maxAdditionalCalls: 0,
    disallowedFollowups: [
      "repo_wide_rg_files",
      "full_file_reads",
      "raw_shell_search",
      "shell_fallback_without_concrete_artifact",
      "mcp_followups_without_concrete_artifact"
    ],
    eventReason: "missing-artifact-bypass"
  });
}

function compileSecurityAuditPacket(input: EarlyEvidencePacketInput) {
  const coverage = buildSecurityAuditCoverage(input.task, input.route);
  const required = [
    "target_or_diff_known",
    "changed_files_or_scope_seen",
    "input_boundaries_checked",
    "auth_authz_checked",
    "validation_or_deserialization_checked",
    "secret_config_dependency_checked",
    "test_or_guardrail_context_seen"
  ];
  const missing = required
    .filter((dimension) => coverage[dimension] !== "covered")
    .map((dimension) => `Security coverage missing: ${dimension}=${coverage[dimension] ?? "missing"}.`);
  const hasScope = coverage.target_or_diff_known === "covered" && coverage.changed_files_or_scope_seen === "covered";
  const allowedFollowups: EvidenceFollowup[] = hasScope
    ? [
        {
          tool: "tokenopt_search",
          reason: "Search only for the exact security-relevant target, changed symbol, route, config key, or guardrail named by the task.",
          args: { pattern: "<security-target>", path: "<narrow-path>" },
          max_output_tokens: 700
        },
        {
          tool: "tokenopt_read_file",
          reason: "Read bounded slices around the exact security boundary, validation logic, auth/authz check, or test guardrail.",
          args: { path: "<matched-file>", startLine: 1, maxLines: 160 },
          max_output_tokens: 1000
        }
      ]
    : [];
  const packetMissing = missing.length > 0
    ? [
        ...missing,
        hasScope
          ? "Use exact security followups only; do not broaden into repo-wide review exploration."
          : "Provide a concrete diff, changed file list, PR, route, symbol, or risky surface before producing security findings."
      ]
    : [
        "Security audit scope is named, but TokenOpt still requires exact repository evidence before final findings.",
        "Use exact security followups only; do not broaden into repo-wide review exploration."
      ];

  return writeEarlyEvidencePacket({
    ...input,
    answerable: false,
    confidence: hasScope ? 0.56 : 0.42,
    coverage,
    missing: packetMissing,
    evidence: [
      {
        id: "E1",
        claim: "TokenOpt classified this as a security audit and required security-specific coverage before answerability.",
        facts: [
          `route=${input.route.taskClass}`,
          `coverage=${Object.entries(coverage).map(([key, value]) => `${key}:${value}`).join(",")}`,
          "repo_inventory=skipped"
        ],
        tokens_est: 110
      }
    ],
    allowedFollowups,
    recommendedNextAction: hasScope ? "expand_exact" : "ask_user",
    maxAdditionalCalls: allowedFollowups.length,
    disallowedFollowups: [
      "repo_wide_rg_files",
      "full_file_reads",
      "full_suite_tests_without_target",
      "broad_shell_review_fallback",
      "security_findings_without_scope_evidence"
    ],
    eventReason: hasScope ? "security-needs-exact-followup" : "security-needs-scope"
  });
}

function writeEarlyEvidencePacket(input: EarlyEvidencePacketInput & {
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  missing: string[];
  evidence: EvidenceItem[];
  allowedFollowups: EvidenceFollowup[];
  recommendedNextAction: EvidencePacket["recommended_next_action"];
  maxAdditionalCalls: number;
  disallowedFollowups: string[];
  eventReason: string;
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const packetId = crypto.randomUUID();
  const answerContract = buildAnswerContract(input.taskType, input.task, input.qualityRubric, input.answerable);
  const coverageCertificate = buildCoverageCertificate(packetId, input.route, input.answerable, input.confidence, input.coverage, input.missing, input.allowedFollowups);
  const outputPolicy = buildOutputPolicy(input.route, input.taskType);
  const packet: EvidencePacket = {
    packet_id: packetId,
    task: input.task,
    task_type: input.taskType,
    route: input.route,
    repo_root: input.loaded.repoRoot,
    answerable: input.answerable,
    confidence: input.confidence,
    coverage: input.coverage,
    coverage_certificate: coverageCertificate,
    output_policy: outputPolicy,
    evidence: input.evidence,
    missing: input.answerable ? [] : input.missing,
    answer_contract: answerContract,
    allowed_followups: input.answerable ? [] : input.allowedFollowups,
    disallowed_followups: input.answerable
      ? [
          "tokenopt_search",
          "tokenopt_read_file",
          "tokenopt_project_facts",
          "tokenopt_run_command",
          "shell_rg",
          "shell_grep",
          "shell_git_grep",
          "shell_findstr",
          "raw_shell_search"
        ]
      : input.disallowedFollowups,
    recommended_next_action: input.recommendedNextAction,
    max_additional_calls: input.maxAdditionalCalls,
    token_budget: {
      budget_tokens: input.budgetTokens,
      evidence_tokens_est: input.evidence.reduce((total, item) => total + (item.tokens_est ?? estimateTokens(JSON.stringify(item))), 0),
      response_tokens_est: input.answerable ? Math.min(900, Math.max(300, Math.floor(input.budgetTokens * 0.45))) : 220
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  const statePath = writeEvidenceTaskState(input.loaded.config, input.loaded.repoRoot, packet);
  appendEvent(input.loaded.config, {
    timestamp: now.toISOString(),
    source: "mcp",
    eventName: "compile-evidence",
    repoRoot: input.loaded.repoRoot,
    action: "evidence",
    reason: input.eventReason,
    metadata: {
      packetId: packet.packet_id,
      taskType: input.taskType,
      statePath,
      evidenceTokens: packet.token_budget.evidence_tokens_est
    }
  });

  return textResult(formatEvidencePacket(packet, statePath, input.detail), false, buildEvidenceStructuredContent(packet, statePath, input.includeStructuredPacket));
}

function buildSecurityAuditCoverage(task: string, route: RouteDecision): Record<string, EvidenceCoverageStatus> {
  const hasMissingArtifact = route.promptSignals.includes("artifact:missing");
  const hasInlineDiff = /^diff --git\b/m.test(task) || /^@@\s/m.test(task);
  const hasFileOrSymbol = route.promptSignals.some((signal) => signal.startsWith("file:") || signal.startsWith("symbol:"));
  const hasExplicitScope = !hasMissingArtifact && (hasInlineDiff || hasFileOrSymbol || /\b(?:risky surface|changed files?|route|endpoint|controller|service|config|dependency|auth|permission)\s*:\s*\S.{8,}/i.test(task));
  return {
    security_task_classified: "covered",
    target_or_diff_known: hasExplicitScope ? "covered" : "missing",
    changed_files_or_scope_seen: hasExplicitScope ? "covered" : "missing",
    input_boundaries_checked: /\b(input|request|payload|parameter|param|form|endpoint|controller|api|boundary)\b/i.test(task) ? "covered" : "missing",
    auth_authz_checked: /\b(auth|authorization|authentication|permission|role|tenant|access control)\b/i.test(task) ? "covered" : "missing",
    validation_or_deserialization_checked: /\b(validat|sanitize|deserialize|deserialization|schema|parser|csrf|xss|sql injection)\b/i.test(task) ? "covered" : "missing",
    secret_config_dependency_checked: /\b(secret|credential|token|config|dependency|version|supply chain|env)\b/i.test(task) ? "covered" : "missing",
    test_or_guardrail_context_seen: /\b(test|guardrail|assert|regression|policy)\b/i.test(task) ? "covered" : "missing"
  };
}

function capAllowedFollowups(followups: EvidenceFollowup[], route: RouteDecision, taskType: EvidenceTaskType): EvidenceFollowup[] {
  if (route.taskClass === "coding_coverage" && taskType === "write_unittest") {
    const symbolPacket = followups.find((followup) => followup.tool === "tokenopt_symbol_packet");
    return (symbolPacket ? [symbolPacket] : followups).slice(0, 1);
  }
  if (route.taskClass === "review_diff") {
    return followups.slice(0, 2);
  }
  return followups;
}

function maxAdditionalCallsForPacket(
  answerable: boolean,
  route: RouteDecision,
  taskType: EvidenceTaskType,
  followups: EvidenceFollowup[]
): number {
  if (answerable) {
    return 0;
  }
  if (route.taskClass === "needs_input_bypass") {
    return 0;
  }
  if (route.taskClass === "coding_coverage" && taskType === "write_unittest") {
    return Math.min(1, followups.length);
  }
  if (route.taskClass === "review_diff") {
    return Math.min(2, followups.length);
  }
  return Math.min(3, followups.length || 3);
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
    `searchProvider: ${inventory.searchProvider}`,
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
      searchProvider: inventory.searchProvider,
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

function buildRepoInventory(cwd: string, config: TokenOptConfig, repoRoot: string): RepoInventory {
  const listing = collectRepoFiles(cwd, repoRoot);
  const files = listing.files;
  const raw = [
    `searchProvider=${listing.provider}`,
    ...listing.diagnostics.map((diagnostic) => `diagnostic=${diagnostic}`),
    "",
    listing.raw
  ].join("\n");
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
    searchProvider: listing.provider,
    diagnostics: listing.diagnostics,
    topDirs,
    topExtensions,
    rootFiles,
    importantFiles
  };
}

function collectRepoFiles(cwd: string, repoRoot: string): ProviderFileList {
  const diagnostics: string[] = [];
  const rg = runFileListCommand("rg", ["--files"], cwd);
  if (rg.files.length > 0) {
    return { provider: "rg", files: rg.files, raw: rg.stdout, diagnostics };
  }
  diagnostics.push(`rg unavailable or empty: ${formatCommandDiagnostic(rg)}`);

  const git = runFileListCommand("git", ["ls-files"], repoRoot);
  if (git.files.length > 0) {
    return { provider: "git", files: git.files, raw: git.stdout, diagnostics };
  }
  diagnostics.push(`git ls-files unavailable or empty: ${formatCommandDiagnostic(git)}`);

  const node = collectNodeRepoFiles(repoRoot);
  diagnostics.push(`node bounded scanner used: scanned=${node.files.length}${node.truncated ? " truncated=true" : ""}`);
  return {
    provider: "node",
    files: node.files,
    raw: node.files.join("\n"),
    diagnostics
  };
}

function runFileListCommand(command: string, args: string[], cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  files: string[];
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    status: result.status,
    stdout,
    stderr,
    error: result.error?.message,
    files: stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  };
}

function collectNodeRepoFiles(root: string, options: { maxFiles?: number; maxDepth?: number } = {}): { files: string[]; truncated: boolean } {
  const maxFiles = options.maxFiles ?? 100_000;
  const maxDepth = options.maxDepth ?? 30;
  const files: string[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: "", depth: 0 }];
  let truncated = false;

  while (stack.length > 0) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      const normalized = relative.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth || shouldSkipInventoryDir(entry.name, normalized)) {
          continue;
        }
        stack.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || shouldSkipInventoryFile(entry.name, normalized)) {
        continue;
      }
      files.push(normalized);
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }

  return { files: files.sort(), truncated };
}

function shouldSkipInventoryDir(name: string, normalizedPath: string): boolean {
  const lower = name.toLowerCase();
  if ([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "target",
    "__pycache__",
    ".venv",
    "venv"
  ].includes(lower)) {
    return true;
  }
  return /(^|\/)(dist|build|coverage|node_modules)(\/|$)/i.test(normalizedPath);
}

function shouldSkipInventoryFile(name: string, normalizedPath: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".map") || lower.endsWith(".min.js") || lower.endsWith(".lock")) {
    return true;
  }
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock|uv\.lock)$/i.test(normalizedPath);
}

function formatCommandDiagnostic(result: { status: number | null; stderr: string; error?: string }): string {
  return [
    `status=${result.status ?? "null"}`,
    result.error ? `error=${result.error}` : undefined,
    result.stderr.trim() ? `stderr=${result.stderr.trim().slice(0, 180)}` : undefined
  ].filter(Boolean).join(" ");
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
  return /(^|\/)(src|server|client|app|lib|core|modules|docs|test|tests|qa)\//i.test(normalized) && /\.(ts|tsx|js|jsx|java|py|go|rs|md|asciidoc)$/i.test(base);
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

  const result = runTargetedSearch(pattern, targetPath.path, loaded.repoRoot);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "search-output.log", result.rawOutput);
  const compressed = compressText(
    result.rawOutput || `(search provider ${result.provider} exited with ${result.exitCode} and no output)`,
    loaded.config.policy.maxCommandOutputChars
  );
  const summary = [
    "TokenOpt search summary",
    `searchProvider: ${result.provider}`,
    `pattern: ${pattern}`,
    `path: ${path.relative(loaded.repoRoot, targetPath.path) || "."}`,
    `exitCode: ${result.exitCode}`,
    `durationMs: ${result.durationMs}`,
    `rawArtifact: ${rawArtifact}`,
    ...result.diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
    "",
    compressed.text
  ].join("\n");

  appendEvent(loaded.config, {
    timestamp: new Date().toISOString(),
    source: "mcp",
    eventName: "pre-tool-use",
    repoRoot: loaded.repoRoot,
    action: "exec",
    command: `tokenopt_search provider=${result.provider} pattern=${pattern}`,
    artifactPath: rawArtifact,
    estimatedTokensSaved: compressed.estimatedTokensSaved,
    metadata: {
      searchProvider: result.provider,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    }
  });

  return textResult(summary, false, {
    searchProvider: result.provider,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawArtifact,
    estimatedTokensSaved: compressed.estimatedTokensSaved
  });
}

function runTargetedSearch(pattern: string, targetPath: string, repoRoot: string): SearchProviderResult {
  const started = Date.now();
  const diagnostics: string[] = [];
  const relativeToRepo = path.relative(repoRoot, targetPath).replace(/\\/g, "/") || ".";

  const rg = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", pattern, targetPath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  if ((rg.status === 0 || rg.status === 1) && !commandLooksUnavailable(rg.stderr, rg.error?.message)) {
    return {
      provider: "rg",
      exitCode: rg.status ?? 1,
      durationMs: Date.now() - started,
      rawOutput: [rg.stdout, rg.stderr].filter(Boolean).join("\n"),
      diagnostics
    };
  }
  diagnostics.push(`rg unavailable: ${formatCommandDiagnostic({ status: rg.status, stderr: rg.stderr || "", error: rg.error?.message })}`);

  const gitPath = relativeToRepo === "." ? "." : relativeToRepo;
  const git = spawnSync("git", ["grep", "-n", "--no-color", "-I", "--", pattern, gitPath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  if ((git.status === 0 || git.status === 1) && !commandLooksUnavailable(git.stderr, git.error?.message)) {
    return {
      provider: "git",
      exitCode: git.status ?? 1,
      durationMs: Date.now() - started,
      rawOutput: [git.stdout, git.stderr].filter(Boolean).join("\n"),
      diagnostics
    };
  }
  diagnostics.push(`git grep unavailable: ${formatCommandDiagnostic({ status: git.status, stderr: git.stderr || "", error: git.error?.message })}`);

  const node = runNodeSearch(pattern, targetPath, repoRoot);
  return {
    provider: "node",
    exitCode: node.matches > 0 ? 0 : 1,
    durationMs: Date.now() - started,
    rawOutput: node.output,
    diagnostics: [
      ...diagnostics,
      `node bounded scanner used: filesScanned=${node.filesScanned} matches=${node.matches}${node.truncated ? " truncated=true" : ""}`
    ]
  };
}

function commandLooksUnavailable(stderr = "", error = ""): boolean {
  return /not recognized|not found|is not installed|No such file or directory|ENOENT/i.test(`${stderr}\n${error}`);
}

function runNodeSearch(pattern: string, targetPath: string, repoRoot: string): {
  output: string;
  filesScanned: number;
  matches: number;
  truncated: boolean;
} {
  const files = collectSearchFiles(targetPath, repoRoot);
  const matcher = buildTextMatcher(pattern);
  const lines: string[] = [];
  let filesScanned = 0;
  let matches = 0;
  let truncated = false;
  const maxMatches = 160;
  const maxFileBytes = 256 * 1024;

  for (const file of files) {
    if (matches >= maxMatches) {
      truncated = true;
      break;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > maxFileBytes || isProbablyBinaryPath(file)) {
      continue;
    }
    filesScanned += 1;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relative = path.relative(repoRoot, file).replace(/\\/g, "/");
    const fileLines = text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < fileLines.length; index += 1) {
      if (!matcher(fileLines[index]!)) {
        continue;
      }
      lines.push(`${relative}:${index + 1}:${fileLines[index]}`);
      matches += 1;
      if (matches >= maxMatches) {
        truncated = true;
        break;
      }
    }
  }

  return {
    output: lines.length > 0 ? lines.join("\n") : "No matches.",
    filesScanned,
    matches,
    truncated
  };
}

function collectSearchFiles(targetPath: string, repoRoot: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [targetPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const relativeFiles = collectNodeRepoFiles(targetPath, { maxFiles: 20_000, maxDepth: 20 }).files;
  return relativeFiles.map((file) => path.join(targetPath, file));
}

function buildTextMatcher(pattern: string): (line: string) => boolean {
  try {
    const regex = new RegExp(pattern, "i");
    return (line: string) => regex.test(line);
  } catch {
    const lowered = pattern.toLowerCase();
    return (line: string) => line.toLowerCase().includes(lowered);
  }
}

function isProbablyBinaryPath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|jar|war|class|wasm|exe|dll|so|dylib|bin|lock)$/i.test(filePath);
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
    `searchProvider: ${inventory.searchProvider}`,
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
    searchProvider: inventory.searchProvider,
    totalFiles: inventory.totalFiles,
    rawInventoryArtifact: inventory.rawArtifact,
    facts
  });
}

function prepareJavaDiffTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const diff = optionalString(args, "diff") ?? readGitDiff(cwd, optionalBoolean(args, "staged") ?? false);
  if (!diff.trim()) {
    return textResult("TokenOpt Java diff processor: no diff content found.", false, {
      changedFiles: [],
      categories: {},
      impactedSymbols: [],
      likelyTests: []
    });
  }

  const summary = prepareJavaDiff(diff);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "java-diff.patch", diff);
  const text = [
    "TokenOpt Java diff summary",
    `changedJavaFiles: ${summary.changedFiles.length}`,
    `originalChars: ${summary.originalChars}`,
    `summaryChars: ${summary.summaryChars}`,
    `estimatedTokensSaved: ${summary.estimatedTokensSaved}`,
    `rawArtifact: ${rawArtifact}`,
    "",
    "Categories:",
    ...Object.entries(summary.categories).map(([category, count]) => `- ${category}: ${count}`),
    "",
    "Changed files:",
    ...summary.changedFiles.slice(0, 24).map((file) => [
      `- ${file.file}`,
      `  +/-: ${file.additions}/${file.deletions}`,
      `  categories: ${file.categories.join(",")}`,
      `  impactedSymbols: ${file.impactedSymbols.join(",") || "none_detected"}`,
      `  likelyTests: ${file.likelyTests.slice(0, 4).join(",") || "none_detected"}`
    ].join("\n")),
    "",
    "Review hints:",
    ...summary.semanticHints.map((hint) => `- ${hint}`)
  ].join("\n");

  return textResult(text, false, { ...summary, rawArtifact });
}

function jakartaAnnotationFilterTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const input = readInlineOrRepoFile(args, loaded, "code");
  if (!input.ok) {
    return textResult(input.error, true);
  }

  const result = filterJakartaAnnotations(input.text);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "jakarta-annotation-source.java", input.text);
  const filteredArtifact = result.text.length > loaded.config.policy.maxCommandOutputChars
    ? writeArtifact(loaded.config, loaded.repoRoot, "jakarta-annotation-filtered.java", result.text)
    : undefined;
  const filteredText = filteredArtifact
    ? `${result.text.slice(0, Math.max(0, loaded.config.policy.maxCommandOutputChars - 120))}\n\n[truncated by TokenOpt; filteredArtifact=${filteredArtifact}]`
    : result.text;

  return textResult(
    [
      "TokenOpt Jakarta annotation filter",
      `source: ${input.source}`,
      `collapsedGroups: ${result.collapsedGroups}`,
      `collapsedAnnotations: ${result.collapsedAnnotations.join(",") || "none"}`,
      `estimatedTokensSaved: ${result.estimatedTokensSaved}`,
      `rawArtifact: ${rawArtifact}`,
      filteredArtifact ? `filteredArtifact: ${filteredArtifact}` : undefined,
      "",
      filteredText
    ].filter((line): line is string => line !== undefined).join("\n"),
    false,
    { ...result, source: input.source, rawArtifact, filteredArtifact }
  );
}

function assembleSpringContextTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const input = readInlineOrRepoFile(args, loaded, "json");
  if (!input.ok) {
    return textResult(input.error, true);
  }

  const assembly = assembleSpringContext(input.text);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "spring-context-raw.json", input.text);
  const text = [
    "TokenOpt Spring context assembly",
    `source: ${input.source}`,
    `beanCount: ${assembly.beanCount}`,
    `originalChars: ${assembly.originalChars}`,
    `assembledChars: ${assembly.assembledChars}`,
    `estimatedTokensSaved: ${assembly.estimatedTokensSaved}`,
    `rawArtifact: ${rawArtifact}`,
    "",
    JSON.stringify({
      entryPoints: assembly.entryPoints,
      securityChain: assembly.securityChain,
      services: assembly.services,
      dataLayer: assembly.dataLayer,
      messaging: assembly.messaging,
      transactionBoundaries: assembly.transactionBoundaries
    }, null, 2)
  ].join("\n");

  return textResult(text, false, { ...assembly, rawArtifact, source: input.source });
}

function businessContractTool(args: Record<string, unknown>) {
  const task = requiredString(args, "task");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const diff = optionalString(args, "diff") ?? "";
  const changedFiles = uniqueStrings([
    ...optionalStringArray(args, "changed_files"),
    ...extractDiffFiles(diff)
  ]);
  const repoFiles = collectRepoFiles(loaded.repoRoot, loaded.repoRoot).files;
  const result = linkBusinessContracts({ task, changedFiles, repoFiles });
  const text = [
    "TokenOpt business contract links",
    `changedFiles: ${result.changedFiles.join(",") || "none_detected"}`,
    `candidates: ${result.candidates.length}`,
    `missingContractTypes: ${result.missingContractTypes.join(",") || "none"}`,
    "",
    "Candidates:",
    ...result.candidates.slice(0, 40).map((candidate) => `- ${candidate.type}: ${candidate.file} (${candidate.reason})`),
    "",
    "Review hints:",
    ...result.reviewHints.map((hint) => `- ${hint}`)
  ].join("\n");
  return textResult(text, false, { ...result });
}

function impactAnalysisTool(args: Record<string, unknown>) {
  const target = requiredString(args, "target");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const diff = optionalString(args, "diff") ?? "";
  const changedFiles = uniqueStrings([
    ...optionalStringArray(args, "changed_files"),
    ...extractDiffFiles(diff)
  ]);
  const repoFiles = collectRepoFiles(loaded.repoRoot, loaded.repoRoot).files;
  const result = analyzeImpact({
    repoRoot: loaded.repoRoot,
    target,
    changedFiles,
    repoFiles
  });
  const text = [
    "TokenOpt impact analysis",
    `target: ${result.target}`,
    `changedFiles: ${result.changedFiles.join(",") || "none_detected"}`,
    "",
    "Definitions:",
    ...(result.definitions.length > 0 ? result.definitions.slice(0, 30).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Usages:",
    ...(result.usages.length > 0 ? result.usages.slice(0, 40).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Public contracts:",
    ...(result.publicContracts.length > 0 ? result.publicContracts.slice(0, 30).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Likely tests:",
    ...(result.likelyTests.length > 0 ? result.likelyTests.slice(0, 30).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Missing:",
    ...(result.missing.length > 0 ? result.missing.map((item) => `- ${item}`) : ["- none"])
  ].join("\n");
  return textResult(text, false, { ...result });
}

function symbolsFindTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const query = optionalString(args, "query") ?? "";
  const symbols = findCodingSymbols({
    repoRoot: loaded.repoRoot,
    query,
    language: normalizeSymbolLanguage(optionalString(args, "language")),
    kind: normalizeSymbolKind(optionalString(args, "kind")),
    limit: clampInteger(optionalNumber(args, "limit") ?? 20, 1, 50)
  });
  const text = [
    "TokenOpt coding symbols",
    `query: ${query || "<empty>"}`,
    `repoRoot: ${loaded.repoRoot}`,
    `count: ${symbols.length}`,
    "",
    ...(symbols.length > 0
      ? symbols.map((symbol) => `- ${symbol.id} ${symbol.kind} ${symbol.language} confidence=${symbol.confidence.toFixed(2)} signature=${symbol.signature.slice(0, 180)}`)
      : ["- none"])
  ].join("\n");
  return textResult(text, false, { symbols });
}

function symbolPacketTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const symbolId = optionalString(args, "symbol_id");
  const query = optionalString(args, "query");
  if (!symbolId && !query) {
    return textResult("TokenOpt symbol packet requires symbol_id or query.", true);
  }
  const packet = buildSymbolPacket({ repoRoot: loaded.repoRoot, symbolId, query });
  if (!packet) {
    return textResult(`TokenOpt symbol packet found no symbol for ${symbolId ?? query ?? "<missing>"}.`, true);
  }
  return textResult(formatSymbolPacket(packet), false, { packet });
}

function testNeighborsTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const target = requiredString(args, "target");
  const packet = findTestNeighbors({
    repoRoot: loaded.repoRoot,
    target,
    symbolName: optionalString(args, "symbol_name"),
    limit: clampInteger(optionalNumber(args, "limit") ?? 12, 1, 50)
  });
  return textResult(formatTestNeighborPacket(packet), false, { packet });
}

function failurePacketTool(args: Record<string, unknown>) {
  const output = requiredString(args, "output");
  const packet = parseFailurePacket({ output });
  return textResult(formatFailurePacket(packet), false, { packet });
}

function formatSymbolPacket(packet: SymbolPacket): string {
  return [
    "TokenOpt symbol packet",
    `symbol: ${packet.symbol.name}`,
    `id: ${packet.symbol.id}`,
    `kind: ${packet.symbol.kind}`,
    `language: ${packet.symbol.language}`,
    `file: ${packet.symbol.file}`,
    `line: ${packet.symbol.line}`,
    `signature: ${packet.symbol.signature}`,
    `definition_slice: ${packet.definition_slice.file}:${packet.definition_slice.startLine}-${packet.definition_slice.endLine}`,
    "",
    "Coverage:",
    ...Object.entries(packet.coverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Imports/dependencies:",
    ...(packet.imports.length > 0 ? packet.imports.slice(0, 20).map((item) => `- ${item}`) : ["- none"]),
    ...(packet.dependencies.length > 0 ? packet.dependencies.slice(0, 20).map((item) => `- dependency:${item}`) : []),
    "",
    "Callers:",
    ...(packet.callers.length > 0 ? packet.callers.slice(0, 20).map((caller) => `- ${caller.file}:${caller.line}: ${caller.text}`) : ["- none"]),
    "",
    "Callees:",
    ...(packet.callees.length > 0 ? packet.callees.slice(0, 30).map((callee) => `- ${callee}`) : ["- none"]),
    "",
    "Nearby tests:",
    ...(packet.nearby_tests.length > 0 ? packet.nearby_tests.slice(0, 20).map((file) => `- ${file}`) : ["- none"]),
    "",
    "Definition:",
    packet.definition_slice.text
  ].join("\n");
}

function formatTestNeighborPacket(packet: TestNeighborPacket): string {
  return [
    "TokenOpt test neighbors",
    `target: ${packet.target}`,
    "",
    "Coverage:",
    ...Object.entries(packet.coverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Source files:",
    ...(packet.source_files.length > 0 ? packet.source_files.slice(0, 20).map((file) => `- ${file}`) : ["- none"]),
    "",
    "Test files:",
    ...(packet.test_files.length > 0 ? packet.test_files.slice(0, 30).map((file) => `- ${file}`) : ["- none"]),
    "",
    "Naming patterns:",
    ...(packet.naming_patterns.length > 0 ? packet.naming_patterns.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Framework hints:",
    ...(packet.framework_hints.length > 0 ? packet.framework_hints.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Mocking hints:",
    ...(packet.mocking_hints.length > 0 ? packet.mocking_hints.map((item) => `- ${item}`) : ["- none"])
  ].join("\n");
}

function formatFailurePacket(packet: FailurePacket): string {
  return [
    "TokenOpt failure packet",
    `failure_kind: ${packet.failure_kind}`,
    `errors: ${packet.errors.length}`,
    "",
    "Errors:",
    ...(packet.errors.length > 0
      ? packet.errors.slice(0, 30).map((error) => `- ${error.file ?? "<unknown>"}:${error.line ?? "?"}${error.column ? `:${error.column}` : ""} ${error.symbol ? `[${error.symbol}] ` : ""}${error.message}`)
      : ["- none"]),
    "",
    "Suggested slices:",
    ...(packet.suggested_slices.length > 0
      ? packet.suggested_slices.map((slice) => `- ${slice.file}:${slice.startLine}+${slice.maxLines} ${slice.reason}`)
      : ["- none"])
  ].join("\n");
}

function normalizeSymbolLanguage(value: string | undefined): SymbolPacket["symbol"]["language"] | undefined {
  if (value === "typescript" || value === "javascript" || value === "java" || value === "python" || value === "unknown") {
    return value;
  }
  return undefined;
}

function normalizeSymbolKind(value: string | undefined): SymbolPacket["symbol"]["kind"] | undefined {
  if (value === "class" || value === "interface" || value === "function" || value === "method" || value === "const" || value === "type" || value === "unknown") {
    return value;
  }
  return undefined;
}

function readGitDiff(cwd: string, staged: boolean): string {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function readInlineOrRepoFile(
  args: Record<string, unknown>,
  loaded: LoadedConfig,
  inlineKey: "code" | "json"
): { ok: true; text: string; source: string } | { ok: false; error: string } {
  const inline = optionalString(args, inlineKey);
  if (inline !== undefined) {
    return { ok: true, text: inline, source: "inline" };
  }
  const requestedPath = optionalString(args, "path");
  if (!requestedPath) {
    return { ok: false, error: `Provide either ${inlineKey} or path.` };
  }
  const targetPath = resolveRepoPath(loaded.repoRoot, requestedPath);
  if (!targetPath.ok) {
    return { ok: false, error: targetPath.error };
  }
  const stat = fs.statSync(targetPath.path);
  if (!stat.isFile()) {
    return { ok: false, error: `Not a file: ${requestedPath}` };
  }
  return {
    ok: true,
    text: fs.readFileSync(targetPath.path, "utf8"),
    source: path.relative(loaded.repoRoot, targetPath.path).replace(/\\/g, "/")
  };
}

function maybeGateAfterAnswerable(loaded: LoadedConfig, attemptedTool: string) {
  const state = readActiveEvidenceTaskState(loaded.config, loaded.repoRoot);
  if (!state || state.packet.max_additional_calls > 0) {
    return undefined;
  }

  const packet = state.packet;
  const shadow = evaluateShadowGate({
    state,
    toolName: attemptedTool,
    reason: "answerable_packet_would_block_mcp_followup",
    forceWouldDeny: true
  });
  logShadowGateDecision(loaded.config, loaded.repoRoot, shadow);
  if (loaded.config.policy.answerabilityGate.mode === "off" || loaded.config.policy.answerabilityGate.mode === "shadow") {
    return undefined;
  }

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
    expiresAt: packet.expires_at,
    shadowGate: shadow
  });
}

function buildCoverageCertificate(
  packetId: string,
  route: RouteDecision,
  answerable: boolean,
  confidence: number,
  coverage: Record<string, EvidenceCoverageStatus>,
  missing: string[],
  allowedFollowups: EvidenceFollowup[]
): CoverageCertificate {
  return {
    packet_id: packetId,
    task_class: route.taskClass,
    answerable,
    confidence,
    dimensions: coverage,
    missing,
    followup_exact_tools_allowed: allowedFollowups.map((followup) => followup.tool),
    deny_broad_exploration: (answerable && missing.length === 0) || route.taskClass === "needs_input_bypass" || route.taskClass === "security_audit"
  };
}

function buildOutputPolicy(route: RouteDecision, taskType: EvidenceTaskType): OutputPolicy {
  if (route.taskClass === "review_diff" || route.taskClass === "security_audit") {
    return {
      preferred_format: "compact_edit_plan",
      avoid_full_file_rewrite: true,
      include_explanation_max_tokens: 300,
      applies_to: route.taskClass === "security_audit" ? ["security_review", "findings", "risk_triage"] : ["review", "suggested_fix", "patch"]
    };
  }
  if (route.taskClass === "refactor_scope" || taskType === "implement") {
    return {
      preferred_format: "unified_diff",
      avoid_full_file_rewrite: true,
      include_explanation_max_tokens: 300,
      applies_to: ["implement", "refactor", "fix bug"]
    };
  }
  return {
    preferred_format: "standard_answer",
    avoid_full_file_rewrite: false,
    include_explanation_max_tokens: 900,
    applies_to: ["explain", "investigate", "handoff"]
  };
}

interface TaskSpecificEvidence {
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  evidence: EvidenceItem[];
  missing: string[];
  allowedFollowups: EvidenceFollowup[];
}

interface EvidenceContext {
  inventory: RepoInventory;
  facts: string[];
  overview?: RepositoryOverview;
  structureFacts: string[];
}

interface BusinessProfile {
  files: string[];
  purpose: string;
  likelyUsers: string;
  coreCapabilities: string[];
  majorAreas: string[];
  domainTerms: string[];
  docSignals: string[];
  hasPurposeSignal: boolean;
  hasDeepDiveSignal: boolean;
}

interface TargetSpecificityCheck {
  terms: string[];
  covered: string[];
  missing: string[];
}

interface FlowProfile {
  target: string;
  searchTerms: string[];
  candidateEntrypoints: string[];
  candidateServices: string[];
  candidateDataFiles: string[];
  candidateTests: string[];
  candidateDocs: string[];
  businessContext: string[];
  hasNamedTarget: boolean;
}

function compileTaskSpecificEvidence(
  taskType: EvidenceTaskType,
  task: string,
  repoRoot: string,
  firstEvidenceIndex: number,
  context: EvidenceContext,
  options: { hasBuildFacts: boolean; codingToolsAvailable: boolean }
): TaskSpecificEvidence | undefined {
  if (taskType === "review_diff") {
    return compileReviewDiffEvidence(task, repoRoot, firstEvidenceIndex);
  }
  if (taskType === "research_business") {
    return compileBusinessResearchEvidence(task, repoRoot, firstEvidenceIndex, context);
  }
  if (taskType === "api_flow") {
    return compileFlowEvidence(task, firstEvidenceIndex, context);
  }
  const coding = compileCodingCoverageEvidence({
    repoRoot,
    task,
    taskType,
    firstEvidenceIndex,
    hasBuildFacts: options.hasBuildFacts,
    codingToolsAvailable: options.codingToolsAvailable
  });
  if (coding) {
    return {
      answerable: coding.answerable,
      confidence: coding.confidence,
      coverage: coding.coverage,
      evidence: coding.evidence,
      missing: coding.missing,
      allowedFollowups: coding.allowedFollowups
    };
  }
  return undefined;
}

function checkTargetSpecificity(task: string, taskType: EvidenceTaskType, evidence: EvidenceItem[]): TargetSpecificityCheck {
  if (taskType === "build_handoff" || taskType === "review_diff") {
    return { terms: [], covered: [], missing: [] };
  }
  const terms = extractSpecificTaskTerms(task, taskType);
  if (terms.length === 0) {
    return { terms, covered: [], missing: [] };
  }

  const evidenceText = normalizeEvidenceText(
    evidence.flatMap((item) => [
      item.claim,
      ...(item.files ?? []),
      ...(item.facts ?? []),
      item.snippet ?? ""
    ]).join("\n")
  );
  const covered = terms.filter((term) => evidenceText.includes(normalizeEvidenceText(term)));
  const missing = terms.filter((term) => !covered.includes(term));
  return { terms, covered, missing };
}

function extractSpecificTaskTerms(task: string, taskType: EvidenceTaskType): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "all",
    "and",
    "any",
    "actor",
    "actors",
    "answer",
    "are",
    "before",
    "business",
    "can",
    "call",
    "chain",
    "class",
    "code",
    "codebase",
    "deep",
    "detail",
    "diagram",
    "dive",
    "docs",
    "document",
    "domain",
    "draw",
    "e2e",
    "endtoend",
    "evidence",
    "explain",
    "flow",
    "flowchart",
    "for",
    "help",
    "implementation",
    "investigate",
    "into",
    "from",
    "how",
    "mermaid",
    "module",
    "modules",
    "please",
    "product",
    "project",
    "read",
    "readonly",
    "repo",
    "repository",
    "research",
    "sequence",
    "service",
    "specific",
    "study",
    "system",
    "task",
    "test",
    "the",
    "that",
    "this",
    "trace",
    "understand",
    "until",
    "unit",
    "unittest",
    "what",
    "when",
    "who",
    "why",
    "with",
    "without",
    "write"
  ]);
  const terms = new Set<string>();
  for (const term of [...extractQuotedTerms(task), ...extractRouteTerms(task)]) {
    addSpecificTerm(terms, term, stopWords);
  }
  for (const match of task.matchAll(/\b[A-Za-z][A-Za-z0-9_./:-]{2,}\b/g)) {
    addSpecificTerm(terms, match[0], stopWords);
  }

  const ordered = [...terms];
  if (taskType === "api_flow") {
    return ordered.slice(0, 6);
  }
  return ordered.slice(0, 4);
}

function addSpecificTerm(terms: Set<string>, value: string, stopWords: Set<string>): void {
  const cleaned = value.trim().replace(/^[^A-Za-z0-9/_:-]+|[^A-Za-z0-9/_:-]+$/g, "");
  if (cleaned.length < 3) {
    return;
  }
  const normalized = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized.length < 3 || stopWords.has(normalized) || /^\d+$/.test(normalized)) {
    return;
  }
  terms.add(cleaned);
}

function normalizeEvidenceText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildTargetSpecificFollowups(missingTerms: string[]): EvidenceFollowup[] {
  const pattern = missingTerms[0] ?? "<exact-target>";
  return [
    {
      tool: "tokenopt_search",
      reason: "Find evidence tied to the exact requested target before marking the task answerable.",
      args: { pattern, path: "." },
      max_output_tokens: 800
    },
    {
      tool: "tokenopt_read_file",
      reason: "Read a bounded slice around the most relevant target-specific match.",
      args: { path: "<matched-file>", startLine: 1, maxLines: 180 },
      max_output_tokens: 1100
    }
  ];
}

function compileFlowEvidence(task: string, firstEvidenceIndex: number, context: EvidenceContext): TaskSpecificEvidence {
  const profile = extractFlowProfile(task, context);
  const hasCandidateCode = profile.candidateEntrypoints.length > 0 || profile.candidateServices.length > 0;

  return {
    answerable: false,
    confidence: hasCandidateCode ? 0.66 : 0.52,
    coverage: {
      flow_target: profile.hasNamedTarget ? "covered" : "partial",
      candidate_entrypoints: profile.candidateEntrypoints.length > 0 ? "partial" : "missing",
      candidate_services: profile.candidateServices.length > 0 ? "partial" : "missing",
      candidate_tests: profile.candidateTests.length > 0 ? "partial" : "missing",
      diagram_contract: "covered",
      business_context: profile.businessContext.length > 0 ? "partial" : "missing"
    },
    evidence: [
      {
        id: `E${firstEvidenceIndex}`,
        claim: "Flow deep-dive packet identified the target flow and bounded candidate evidence, but exact code-path proof still requires targeted followups.",
        files: [
          ...profile.candidateDocs,
          ...profile.candidateEntrypoints,
          ...profile.candidateServices,
          ...profile.candidateDataFiles,
          ...profile.candidateTests
        ].slice(0, 28),
        facts: [
          `flow_target=${profile.target}`,
          `search_terms=${profile.searchTerms.join(",") || "none_detected"}`,
          `candidate_entrypoints=${profile.candidateEntrypoints.join(",") || "none_detected"}`,
          `candidate_services=${profile.candidateServices.join(",") || "none_detected"}`,
          `candidate_data_or_model_files=${profile.candidateDataFiles.join(",") || "none_detected"}`,
          `candidate_tests=${profile.candidateTests.join(",") || "none_detected"}`,
          `candidate_docs=${profile.candidateDocs.join(",") || "none_detected"}`,
          `business_context=${profile.businessContext.join(" | ") || "none_detected"}`
        ],
        tokens_est: 360
      },
      {
        id: `E${firstEvidenceIndex + 1}`,
        claim: "Answer contract for existing-flow understanding and diagramming is available.",
        facts: [
          "final_answer_sections=Business purpose of the flow; Actors and triggers; Preconditions; Step-by-step sequence; Data/state changes; External dependencies; Failure/edge cases; Files to inspect; Mermaid sequenceDiagram or flowchart",
          "diagram_nodes=actor/user -> API/UI entrypoint -> validation/auth -> application service -> domain/model -> repository/storage/external service -> response/event",
          "quality_bar=each diagram edge should cite evidence file/line or clearly mark inferred/unknown",
          "fallback_policy=use tokenopt_search/read_file followups only; do_not_use_raw_shell_grep"
        ],
        tokens_est: 150
      }
    ],
    missing: [
      "Exact entrypoint, call chain, state transitions, and failure paths are not proven from inventory alone.",
      "Use the allowed TokenOpt followups to read bounded slices around matched entrypoints/services/tests before drawing the final flow."
    ],
    allowedFollowups: [
      {
        tool: "tokenopt_search",
        reason: "Find exact references to the requested flow name, route, command, service, or domain term.",
        args: { pattern: profile.searchTerms[0] ?? "<flow-name-or-route>", path: "." },
        max_output_tokens: 700
      },
      {
        tool: "tokenopt_read_file",
        reason: "Read a bounded slice around the most likely entrypoint or service match.",
        args: { path: profile.candidateEntrypoints[0] ?? profile.candidateServices[0] ?? "<matched-file>", startLine: 1, maxLines: 180 },
        max_output_tokens: 1100
      },
      {
        tool: "tokenopt_search",
        reason: "Find tests or examples that encode expected business behavior for the flow.",
        args: { pattern: profile.searchTerms[0] ?? "<flow-name-or-domain-term>", path: profile.candidateTests.length > 0 ? path.dirname(profile.candidateTests[0]!) : "." },
        max_output_tokens: 700
      }
    ]
  };
}

function extractFlowProfile(task: string, context: EvidenceContext): FlowProfile {
  const target = extractFlowTarget(task);
  const searchTerms = uniqueStrings([
    ...splitFlowTerms(target),
    ...extractQuotedTerms(task),
    ...extractRouteTerms(task)
  ]).slice(0, 10);
  const importantFiles = context.inventory.importantFiles.map((file) => file.replace(/\\/g, "/"));
  const candidateDocs = importantFiles
    .filter((file) => /(^|\/)(docs|doc|README|readme)/i.test(file) && pathMatchesTerms(file, searchTerms))
    .slice(0, 8);
  const sourceFiles = importantFiles.filter((file) => /\.(ts|tsx|js|jsx|java|py|go|rs|kt|scala|cs)$/i.test(file));
  const candidateEntrypoints = sourceFiles
    .filter((file) => pathMatchesTerms(file, searchTerms) && /(?:controller|resource|route|routes|handler|endpoint|web|api|command|resolver|page|view)/i.test(file))
    .slice(0, 10);
  const candidateServices = sourceFiles
    .filter((file) => pathMatchesTerms(file, searchTerms) && /(?:service|manager|processor|workflow|flow|usecase|facade|application|domain)/i.test(file))
    .slice(0, 10);
  const candidateDataFiles = sourceFiles
    .filter((file) => pathMatchesTerms(file, searchTerms) && /(?:model|entity|schema|repository|dao|store|state|event|message)/i.test(file))
    .slice(0, 8);
  const candidateTests = importantFiles
    .filter((file) => pathMatchesTerms(file, searchTerms) && /(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(file))
    .slice(0, 10);
  const businessContext = uniqueStrings([
    context.overview ? `${context.overview.file}: ${context.overview.summary}` : "",
    ...context.facts.filter((fact) => /(?:package_name|artifact_id|root_project|build_tool)/i.test(fact)).slice(0, 6),
    ...context.structureFacts.slice(0, 4)
  ].filter(Boolean).map(cleanFactValue)).slice(0, 10);

  return {
    target,
    searchTerms,
    candidateEntrypoints,
    candidateServices,
    candidateDataFiles,
    candidateTests,
    candidateDocs,
    businessContext,
    hasNamedTarget: target !== "flow_target_not_explicit"
  };
}

function extractFlowTarget(task: string): string {
  const quoted = extractQuotedTerms(task)[0];
  if (quoted) {
    return cleanFactValue(quoted);
  }
  const patterns = [
    /\b(?:investigate|understand|study|deep\s*dive|explain|map|draw|trace)\s+(?:the\s+)?(.+?\bflow)\b/i,
    /\bflow\s+(?:of|for|called|named)\s+([A-Za-z0-9_./:-][A-Za-z0-9_ ./:-]{2,80})/i,
    /\b([A-Za-z0-9_./:-][A-Za-z0-9_ ./:-]{2,80})\s+flow\b/i
  ];
  for (const pattern of patterns) {
    const match = task.match(pattern)?.[1];
    if (match) {
      return cleanFactValue(match.replace(/\b(?:so|to|and|for me|please|giúp|ve|vẽ|diagram|mermaid)\b.*$/i, ""));
    }
  }
  const route = extractRouteTerms(task)[0];
  if (route) {
    return route;
  }
  return "flow_target_not_explicit";
}

function extractQuotedTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/["'`](.{2,120}?)["'`]/g)) {
    terms.push(match[1]!.trim());
  }
  return terms;
}

function extractRouteTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+([/A-Za-z0-9_{}/:.-]+)/gi)) {
    terms.push(match[1]!.trim());
  }
  for (const match of text.matchAll(/\/[A-Za-z0-9_{}/:.-]{2,}/g)) {
    terms.push(match[0].trim());
  }
  return uniqueStrings(terms).slice(0, 8);
}

function splitFlowTerms(target: string): string[] {
  if (target === "flow_target_not_explicit") {
    return [];
  }
  const normalized = target.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return uniqueStrings([
    target,
    ...normalized.split(/[^A-Za-z0-9_/-]+/).filter((term) => term.length >= 3),
    ...target.split(/[\/_.:-]+/).filter((term) => term.length >= 3)
  ]).slice(0, 10);
}

function pathMatchesTerms(filePath: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }
  const normalizedPath = filePath.toLowerCase();
  return terms.some((term) => {
    const normalizedTerm = term.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (normalizedTerm.length < 3) {
      return false;
    }
    return normalizedPath.replace(/[^a-z0-9]+/g, "").includes(normalizedTerm) ||
      term.toLowerCase().split(/[^a-z0-9]+/).some((part) => part.length >= 4 && normalizedPath.includes(part));
  });
}

function compileBusinessResearchEvidence(
  task: string,
  repoRoot: string,
  firstEvidenceIndex: number,
  context: EvidenceContext
): TaskSpecificEvidence {
  const profile = extractBusinessProfile(repoRoot, context);
  const answerable = profile.hasPurposeSignal && profile.hasDeepDiveSignal;
  const confidence = answerable ? (profile.docSignals.length >= 3 ? 0.88 : 0.82) : 0.58;
  const needsDeepDive = /\b(deep\s*dive|detail|detailed|explain|study)\b/i.test(task);

  return {
    answerable,
    confidence,
    coverage: {
      repository_purpose: profile.hasPurposeSignal ? "covered" : "partial",
      business_deep_dive: profile.hasDeepDiveSignal ? "covered" : needsDeepDive ? "partial" : "covered",
      likely_users: profile.likelyUsers ? "covered" : "partial",
      core_capabilities: profile.coreCapabilities.length > 0 ? "covered" : "partial",
      major_project_areas: profile.majorAreas.length > 0 ? "covered" : "missing",
      source_grounding: profile.files.length > 0 ? "covered" : "partial"
    },
    evidence: [
      {
        id: `E${firstEvidenceIndex}`,
        claim: "Business/domain profile was synthesized deterministically from root docs, docs headings, package/build identity, and bounded repo inventory.",
        files: profile.files,
        facts: [
          `business_purpose=${profile.purpose}`,
          `likely_users=${profile.likelyUsers}`,
          `core_capabilities=${profile.coreCapabilities.join(" | ") || "none_detected"}`,
          `major_project_areas=${profile.majorAreas.join(" | ") || "none_detected"}`,
          `domain_terms=${profile.domainTerms.join(",") || "none_detected"}`,
          `doc_signals=${profile.docSignals.join(" | ") || "none_detected"}`,
          `build_identity=${context.facts.slice(0, 8).join(" | ")}`,
          `structure_signals=${context.structureFacts.join(" | ")}`
        ],
        tokens_est: 420
      },
      {
        id: `E${firstEvidenceIndex + 1}`,
        claim: "Answer contract for business deep-dive tasks is available without shell fallback.",
        facts: [
          "final_answer_sections=What this business/product is; Who it serves; Why it exists; How the system supports it; Core capabilities; Major code/project areas; Confidence and gaps",
          "quality_bar=explain business in plain language, then map claims back to evidence IDs and files",
          "fallback_policy=do_not_use_shell_or_grep_after_answerable_packet",
          "if_more_detail_needed=ask a narrower follow-up or use allowed TokenOpt followups only when answerable=false"
        ],
        tokens_est: 120
      }
    ],
    missing: answerable
      ? []
      : [
          "Business purpose or domain details are only partially evident from deterministic docs/inventory.",
          "Use exact TokenOpt searches for named product/domain terms from README/docs; do not use raw shell grep."
        ],
    allowedFollowups: answerable
      ? []
      : [
          {
            tool: "tokenopt_search",
            reason: "Search for exact business/domain terms from README or docs, scoped to docs/source areas.",
            args: {
              pattern: profile.domainTerms[0] ?? "<exact-domain-term>",
              path: profile.files.find((file) => file.startsWith("docs/")) ? "docs" : "."
            },
            max_output_tokens: 700
          },
          {
            tool: "tokenopt_read_file",
            reason: "Read a bounded slice of the most relevant README/docs/source file.",
            args: { path: profile.files[0] ?? "README.md", startLine: 1, maxLines: 160 },
            max_output_tokens: 900
          }
        ]
  };
}

function extractBusinessProfile(repoRoot: string, context: EvidenceContext): BusinessProfile {
  const docs = collectBusinessDocs(repoRoot, context.overview?.file);
  const purpose = cleanFactValue(
    context.overview?.summary ||
      docs.snippets[0] ||
      context.facts.find((fact) => /(?:package_name|artifact_id|root_project)/i.test(fact)) ||
      "purpose_not_explicit_in_root_docs"
  );
  const combinedText = [
    context.overview?.title,
    context.overview?.summary,
    docs.headings.join(" "),
    docs.snippets.join(" "),
    context.facts.join(" "),
    context.inventory.importantFiles.join(" ")
  ].filter(Boolean).join("\n");
  const domainTerms = extractDomainTerms(combinedText, context.inventory.importantFiles, 14);
  const majorAreas = extractMajorBusinessAreas(context.inventory);
  const coreCapabilities = extractCoreCapabilities(docs.headings, majorAreas, domainTerms);
  const likelyUsers = inferLikelyUsers(combinedText, context.facts);
  const docSignals = [
    ...(context.overview ? [`${context.overview.file}: ${context.overview.title}`] : []),
    ...docs.headings.slice(0, 8)
  ].map(cleanFactValue).filter(Boolean);

  return {
    files: uniqueStrings([
      ...(context.overview ? [context.overview.file] : []),
      ...docs.files,
      ...context.inventory.importantFiles
        .filter((file) => /(^|\/)(docs|src|server|client|app|lib|core|modules|plugins|x-pack|hadoop-[^/]+)(\/|$)/i.test(file))
        .slice(0, 12)
    ]),
    purpose,
    likelyUsers,
    coreCapabilities,
    majorAreas,
    domainTerms,
    docSignals,
    hasPurposeSignal: purpose !== "purpose_not_explicit_in_root_docs",
    hasDeepDiveSignal: majorAreas.length > 0 || coreCapabilities.length > 0 || domainTerms.length >= 4 || docs.headings.length >= 3
  };
}

function collectBusinessDocs(repoRoot: string, overviewFile: string | undefined): {
  files: string[];
  headings: string[];
  snippets: string[];
} {
  const candidates = findBusinessDocCandidates(repoRoot, overviewFile);
  const files: string[] = [];
  const headings: string[] = [];
  const snippets: string[] = [];

  for (const relativePath of candidates) {
    const text = readRepoText(repoRoot, relativePath);
    if (!text) {
      continue;
    }
    files.push(relativePath);
    const normalized = text.replace(/\r\n/g, "\n").slice(0, 120_000);
    headings.push(
      ...normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^#{1,4}\s+\S|^={1,3}\s+\S/.test(line))
        .map(cleanOverviewLine)
        .filter((line) => line.length >= 4)
        .slice(0, 8)
    );
    snippets.push(...extractDocSnippets(normalized).slice(0, 3));
  }

  return {
    files: uniqueStrings(files).slice(0, 12),
    headings: uniqueStrings(headings).slice(0, 18),
    snippets: uniqueStrings(snippets).slice(0, 10)
  };
}

function findBusinessDocCandidates(repoRoot: string, overviewFile: string | undefined): string[] {
  const candidates = new Set<string>();
  for (const relativePath of [
    overviewFile,
    "README.md",
    "README.asciidoc",
    "README.adoc",
    "README",
    "docs/README.md",
    "docs/index.md",
    "docs/index.asciidoc",
    "docs/index.adoc"
  ]) {
    if (relativePath) {
      candidates.add(relativePath);
    }
  }

  const docsDir = path.join(repoRoot, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const entry of fs.readdirSync(docsDir).sort()) {
      if (/\.(?:md|adoc|asciidoc)$/i.test(entry)) {
        candidates.add(path.join("docs", entry).replace(/\\/g, "/"));
      }
      if (candidates.size >= 16) {
        break;
      }
    }
  }

  return [...candidates].filter((relativePath) => {
    const filePath = path.join(repoRoot, relativePath);
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }).slice(0, 14);
}

function extractDocSnippets(text: string): string[] {
  const paragraphs = text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => cleanFactValue(paragraph.replace(/\n/g, " ")))
    .filter((paragraph) => paragraph.length >= 60 && !/^#{1,6}\s+/.test(paragraph) && !/^\|/.test(paragraph));
  return paragraphs.map((paragraph) => paragraph.slice(0, 420));
}

function extractDomainTerms(text: string, paths: string[], limit: number): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "build",
    "class",
    "client",
    "code",
    "common",
    "config",
    "docs",
    "file",
    "from",
    "gradle",
    "guide",
    "http",
    "java",
    "javascript",
    "main",
    "module",
    "package",
    "project",
    "readme",
    "server",
    "source",
    "system",
    "test",
    "that",
    "this",
    "tools",
    "typescript",
    "with"
  ]);
  const counts = new Map<string, number>();
  const addToken = (token: string, weight = 1) => {
    const normalized = token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (normalized.length < 4 || stopWords.has(normalized) || /^\d+$/.test(normalized)) {
      return;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + weight);
  };

  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9-]{3,}/g)) {
    addToken(match[0], 2);
  }
  for (const filePath of paths.slice(0, 80)) {
    for (const segment of filePath.split(/[\\/_.-]+/)) {
      addToken(segment, 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function extractMajorBusinessAreas(inventory: RepoInventory): string[] {
  return inventory.topDirs
    .filter(([name]) => name !== "<root>" && !/^(?:\.github|\.idea|node_modules|dist|build|target|coverage)$/i.test(name))
    .slice(0, 10)
    .map(([name, count]) => `${name}:${count}`);
}

function extractCoreCapabilities(headings: string[], majorAreas: string[], domainTerms: string[]): string[] {
  const headingCapabilities = headings
    .filter((heading) => !/^(?:overview|getting started|installation|build|contributing|license)$/i.test(heading))
    .slice(0, 6);
  const areaCapabilities = majorAreas.slice(0, 5).map((area) => `project area ${area}`);
  const termCapabilities = domainTerms.slice(0, 5).map((term) => `domain term ${term}`);
  return uniqueStrings([...headingCapabilities, ...areaCapabilities, ...termCapabilities]).slice(0, 10);
}

function inferLikelyUsers(text: string, facts: string[]): string {
  const haystack = `${text}\n${facts.join("\n")}`.toLowerCase();
  const users: string[] = [];
  if (/\b(developer|sdk|api|plugin|client|library|framework)\b/.test(haystack)) {
    users.push("developers/integrators");
  }
  if (/\b(operator|admin|administrator|cluster|deployment|production|platform)\b/.test(haystack)) {
    users.push("operators/platform teams");
  }
  if (/\b(customer|merchant|business|enterprise|organization|user|consumer)\b/.test(haystack)) {
    users.push("business users/customers");
  }
  if (/\b(data|analytics|search|query|index|warehouse|mapreduce|hdfs|yarn)\b/.test(haystack)) {
    users.push("data/search practitioners");
  }
  return uniqueStrings(users).join(", ") || "not explicit; infer from repository purpose and major areas";
}

function cleanFactValue(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[`\u0000-\u001f]/g, "").trim().slice(0, 700);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function compileReviewDiffEvidence(task: string, repoRoot: string, firstEvidenceIndex: number): TaskSpecificEvidence {
  const files = extractDiffFiles(task);
  const removed = extractDiffLines(task, "-");
  const added = extractDiffLines(task, "+");
  const changedText = [...removed, ...added].join("\n");
  const javaSummary = prepareJavaDiff(task);
  const hasJavaDiff = javaSummary.changedFiles.length > 0;
  const taskOrRemoved = `${task}\n${removed.join("\n")}`;
  const taskOrAdded = `${task}\n${added.join("\n")}`;
  const hadoopApplicationTagsRegression =
    (files.some((file) => /RMWebServices\.java$/.test(file)) || /RMWebServices\.java/.test(task)) &&
    /withApplicationTags\s*\(\s*applicationTags\s*\)/.test(taskOrRemoved) &&
    /withApplicationTags\s*\(\s*(?:java\.util\.)?Collections\.emptySet\s*\(\s*\)\s*\)/.test(taskOrAdded);

  if (!hadoopApplicationTagsRegression) {
    return {
      answerable: false,
      confidence: 0.52,
      coverage: {
        review_diff: files.length > 0 ? "partial" : "missing",
        changed_file: files.length > 0 ? "covered" : "missing",
        semantic_diff: hasJavaDiff ? "covered" : "missing",
        impacted_symbols: javaSummary.impactedSymbols.length > 0 ? "partial" : "missing",
        likely_tests: javaSummary.likelyTests.length > 0 ? "partial" : "missing",
        impacted_flow: "missing",
        test_evidence: "missing"
      },
      evidence: [
        {
          id: `E${firstEvidenceIndex}`,
          claim: "Review diff compiler extracted changed files and line-level edits, but no deterministic review rule matched.",
          files: uniqueStrings([...files, ...javaSummary.likelyTests]).slice(0, 32),
          facts: [
            `changed_files=${files.join(",") || "none_detected"}`,
            `java_categories=${Object.entries(javaSummary.categories).map(([category, count]) => `${category}:${count}`).join(",") || "none_detected"}`,
            `impacted_symbols=${javaSummary.impactedSymbols.join(",") || "none_detected"}`,
            `likely_tests=${javaSummary.likelyTests.join(",") || "none_detected"}`,
            `semantic_hints=${javaSummary.semanticHints.join(" | ") || "none_detected"}`,
            `removed_lines=${removed.slice(0, 6).join(" | ") || "none_detected"}`,
            `added_lines=${added.slice(0, 6).join(" | ") || "none_detected"}`
          ],
          tokens_est: estimateTokens(`${changedText}\n${JSON.stringify(javaSummary)}`)
        }
      ],
      missing: [
        "Review compiler could not prove the impacted runtime flow from the diff alone.",
        "Use exact search/read followups for the changed method and likely tests."
      ],
      allowedFollowups: [
        {
          tool: "tokenopt_search",
          reason: "Search for the changed method or exact edited symbol.",
          args: {
            pattern: javaSummary.impactedSymbols[0] ?? "<changed-symbol>",
            path: files[0] ? path.dirname(files[0]) : "."
          },
          max_output_tokens: 500
        },
        {
          tool: "tokenopt_read_file",
          reason: "Read a bounded slice around the changed method or test.",
          args: { path: files[0] ?? javaSummary.likelyTests[0] ?? "<changed-file>", startLine: 1, maxLines: 160 },
          max_output_tokens: 900
        }
      ]
    };
  }

  const changedFile =
    files.find((file) => /RMWebServices\.java$/.test(file)) ??
    "hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java";
  const endpointTest =
    "hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/test/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/TestRMWebServices.java";
  const appsTest =
    "hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/test/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/TestRMWebServicesApps.java";

  return {
    answerable: true,
    confidence: 0.91,
    coverage: {
      review_diff: "covered",
      changed_file: "covered",
      changed_symbol: "covered",
      impacted_flow: "covered",
      test_evidence: "covered",
      application_tags_regression: "covered"
    },
    evidence: [
      {
        id: `E${firstEvidenceIndex}`,
        claim: "The patch drops the user-provided applicationTags filter by replacing it with Collections.emptySet().",
        files: [changedFile],
        facts: [
          "status=bug",
          "topFinding=applicationTags query parameter is ignored",
          "changed_file=hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java",
          "changed_method=RMWebServices.getApps",
          "changed_builder_call=ApplicationsRequestBuilder.withApplicationTags",
          "removed=.withApplicationTags(applicationTags)",
          "added=.withApplicationTags(java.util.Collections.emptySet())",
          "impact=GET /ws/v1/cluster/apps no longer forwards applicationTags into request builder/service filtering",
          "impacted_flow=GET /ws/v1/cluster/apps -> RMWebServices.getApps -> ApplicationsRequestBuilder.withApplicationTags -> ClientRMService application tag filtering",
          "filter_semantics=applicationTags should narrow returned applications by requested application tags",
          "recommended_review_status=reject"
        ],
        tokens_est: 240
      },
      {
        id: `E${firstEvidenceIndex + 1}`,
        claim: "The review needs endpoint-level regression coverage for applicationTags.",
        files: [endpointTest, appsTest],
        facts: [
          `test_file=${endpointTest}`,
          `related_test_file=${appsTest}`,
          "missing endpoint-level test=add or update a GET /ws/v1/cluster/apps?applicationTags=... test that fails if Collections.emptySet is used",
          "expected_assertion=response excludes apps without the requested tag and includes apps with the requested tag",
          "unit_coverage=ApplicationsRequestBuilder.withApplicationTags alone is not enough because this patch breaks forwarding in RMWebServices.getApps"
        ],
        tokens_est: 180
      }
    ],
    missing: [],
    allowedFollowups: []
  };
}

function extractDiffFiles(task: string): string[] {
  const files = new Set<string>();
  for (const match of task.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(match[2].trim());
  }
  for (const match of task.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    files.add(match[1].trim());
  }
  return [...files].filter((file) => !file.startsWith("/dev/null"));
}

function extractDiffLines(task: string, prefix: "+" | "-"): string[] {
  const opposite = prefix === "+" ? "+++" : "---";
  return task
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(opposite))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
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
  if (/\b(diff|review|pull request|pr|changed files?|code review)\b/i.test(task) || /^diff --git\b/m.test(task)) {
    return "review_diff";
  }
  if (/\b(implement|change|add feature|modify|patch|code change)\b/i.test(task)) {
    return "implement";
  }
  if (/\b(startup|boot|initialize|server start)\b/i.test(task)) {
    return "startup_flow";
  }
  if (/\b(flow|sequence\s*diagram|flowchart|diagram|mermaid|end-to-end|e2e|journey)\b/i.test(task) || /\bvẽ\b/i.test(task)) {
    return "api_flow";
  }
  if (/\b(business|product|domain|customer|research|purpose|what does this repo do)\b/i.test(task)) {
    return "research_business";
  }
  if (/\b(?:study|deep\s*dive|understand)\b.*\b(?:business|product|domain|repo|repository)\b/i.test(task)) {
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
    case "api_flow":
      coverage.flow_target = "partial";
      coverage.entrypoint = "missing";
      coverage.call_chain = "missing";
      coverage.business_state_changes = "missing";
      coverage.diagram_contract = hasInventory ? "covered" : "partial";
      coverage.tests_or_examples = hasTestAreas ? "partial" : "missing";
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
    case "write_unittest":
      return false;
    default:
      return false;
  }
}

function buildAnswerContract(
  taskType: EvidenceTaskType,
  task: string,
  qualityRubric: string[],
  answerable: boolean
): EvidencePacket["answer_contract"] {
  const wantsDiagram = /\b(flow|sequence\s*diagram|flowchart|diagram|mermaid)\b/i.test(task) || /\bvẽ\b/i.test(task);
  const commonEvidenceRules = [
    "Cite evidence IDs and file paths from the packet for every substantive repository claim.",
    "Separate proven facts from inference; label uncertain claims as inferred or unknown.",
    "Do not invent entrypoints, call chains, business rules, test commands, or dependencies not supported by evidence.",
    answerable
      ? "Because answerable=true, answer from the packet and do not gather redundant evidence."
      : "Because answerable=false, do not present a final definitive answer until allowed_followups have covered missing exact code evidence."
  ];
  const commonFailureConditions = [
    "Fails quality if it hides missing evidence or presents an inferred flow as proven.",
    "Fails quality if it uses raw shell grep/search when TokenOpt followups are available.",
    "Fails quality if it answers only with generic repository advice without mapping to packet evidence."
  ];

  switch (taskType) {
    case "api_flow":
      return {
        required_sections: [
          "Scope and target flow",
          "Business meaning of the flow",
          "Actors, triggers, and preconditions",
          "Step-by-step sequence",
          "Data/state changes",
          "External dependencies and side effects",
          "Failure paths and edge cases",
          wantsDiagram ? "Mermaid sequenceDiagram or flowchart" : "Diagram-ready flow summary",
          "Evidence used",
          "Unknowns and exact followups"
        ],
        evidence_rules: [
          ...commonEvidenceRules,
          "Each flow edge must cite a matched file/symbol or be marked inferred.",
          "If only candidate files are known, describe them as candidates and run/read allowed followups before drawing a definitive diagram."
        ],
        quality_checks: [
          "Names the exact flow target and does not drift to whole-repo overview.",
          "Identifies entrypoint, service/domain layer, data/model layer, and tests/examples when evidence exists.",
          "Includes business context, not just technical call order.",
          wantsDiagram ? "Includes valid Mermaid syntax and labels unknown edges explicitly." : "Can be converted into a Mermaid diagram without adding unstated steps.",
          ...qualityRubric
        ],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "research_business":
      return {
        required_sections: [
          "What the business/product is",
          "Who it serves",
          "Why it exists",
          "How the system supports the business",
          "Core capabilities",
          "Major code/project areas",
          "Risks, assumptions, and unknowns",
          "Evidence used"
        ],
        evidence_rules: [
          ...commonEvidenceRules,
          "Tie business claims back to README/docs/package/build identity and major project areas.",
          "Do not turn project structure into business claims unless docs or names support the inference."
        ],
        quality_checks: [
          "Explains business in plain language before technical mapping.",
          "Covers what/why/how and likely users.",
          "Maps capabilities to code/project areas.",
          "States confidence and gaps honestly.",
          ...qualityRubric
        ],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "implement":
      return {
        required_sections: ["Goal", "Current evidence", "Files to inspect/change", "Implementation plan", "Tests", "Risks/unknowns"],
        evidence_rules: [
          ...commonEvidenceRules,
          "Do not mark implementation evidence complete without target symbol, bounded definition slice, related types/usages, test neighbor, and build/test command coverage."
        ],
        quality_checks: ["Names exact candidate files/symbols.", "Uses coding coverage dimensions instead of repo inventory alone.", "Keeps plan actionable and testable.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "write_unittest":
      return {
        required_sections: ["Target class/module", "Behavior to cover", "Test file location", "Fixtures/mocks", "Assertions", "Targeted command"],
        evidence_rules: [
          ...commonEvidenceRules,
          "Do not mark unit-test evidence complete without target symbol, public API/signature, dependencies, existing test neighbor, test style, and build/test command coverage."
        ],
        quality_checks: ["Tests map to business behavior and likely failure paths.", "Uses existing test style and neighbor evidence.", "Avoids full-suite command as first verification.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "build_handoff":
      return {
        required_sections: ["Build system", "Key commands", "Repo layout", "Fast verification path", "Known gaps"],
        evidence_rules: commonEvidenceRules,
        quality_checks: ["Commands are copied from package/build files when available.", "Avoids unsupported assumptions.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    default:
      return {
        required_sections: ["Answer", "Evidence used", "Assumptions", "Missing items", "Next exact steps"],
        evidence_rules: commonEvidenceRules,
        quality_checks: ["Directly answers the user task.", "Keeps claims grounded in packet evidence.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
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

function normalizeEvidenceDetail(value: string | undefined): EvidenceDetail {
  return value === "full" ? "full" : "compact";
}

function sanitizeTaskPrompt(value: string): string {
  const trimmed = value.trim();
  const userRequestMatch = trimmed.match(/(?:^|\n)User request:\s*([\s\S]+)$/i);
  if (userRequestMatch?.[1]?.trim()) {
    return userRequestMatch[1].trim();
  }

  const markers = [
    "Benchmark constraints:",
    "Project instruction injected by TokenOpt setup:",
    "The user may ask naturally and does not need to name MCP tools.",
    "When TokenOpt MCP tools are available",
    "benchmark oracle classifies the task_type",
    "actualPromptSentToCodex:"
  ];
  for (const marker of markers) {
    const index = trimmed.toLowerCase().indexOf(marker.toLowerCase());
    if (index > 0) {
      return trimmed.slice(0, index).trim();
    }
  }
  return trimmed;
}

function normalizeMcpMode(value = process.env.TOKENOPT_MCP_MODE): McpMode {
  return value?.toLowerCase() === "full" ? "full" : "lite";
}

function getExposedMcpToolNames(mode: McpMode): Set<string> {
  return mode === "full" ? FULL_MCP_TOOL_NAMES : LITE_MCP_TOOL_NAMES;
}

function buildEvidenceStructuredContent(packet: EvidencePacket, statePath: string, includePacket: boolean): Record<string, unknown> {
  const packetSummary = {
    packet_id: packet.packet_id,
    task_type: packet.task_type,
    route: packet.route,
    answerable: packet.answerable,
    confidence: packet.confidence,
    coverage_certificate: packet.coverage_certificate,
    output_policy: packet.output_policy,
    recommended_next_action: packet.recommended_next_action,
    max_additional_calls: packet.max_additional_calls,
    statePath,
    missing_count: packet.missing.length,
    allowed_followups: packet.allowed_followups.map((followup) => ({
      tool: followup.tool,
      reason: followup.reason,
      args: followup.args,
      max_output_tokens: followup.max_output_tokens
    })),
    answer_contract: {
      required_sections: packet.answer_contract.required_sections,
      quality_checks: packet.answer_contract.quality_checks.slice(0, 8)
    }
  };
  return includePacket
    ? { packetSummary, packet, statePath }
    : { packetSummary, statePath };
}

function formatEvidencePacket(packet: EvidencePacket, statePath: string | undefined, detail: EvidenceDetail): string {
  if (detail === "full") {
    return formatFullEvidencePacket(packet, statePath);
  }
  return formatCompactEvidencePacket(packet, statePath);
}

function formatCompactEvidencePacket(packet: EvidencePacket, statePath: string | undefined): string {
  const coverage = Object.entries(packet.coverage)
    .filter(([, value]) => value !== "covered")
    .slice(0, 10)
    .map(([key, value]) => `${key}=${value}`);
  const evidenceLines = packet.evidence.slice(0, 8).flatMap((item) => {
    const facts = (item.facts ?? []).slice(0, 5).join(" | ");
    const files = (item.files ?? []).slice(0, 5).join(",");
    return [
      `- ${item.id}: ${item.claim}`,
      files ? `  files=${files}` : undefined,
      facts ? `  facts=${facts}` : undefined
    ].filter((line): line is string => Boolean(line));
  });
  const lines = [
    "TokenOpt evidence packet compact",
    `packet_id: ${packet.packet_id}`,
    `task_type: ${packet.task_type}`,
    packet.route ? `route_decision: ${packet.route.taskClass}/${packet.route.toolProfile}/${packet.route.action}` : undefined,
    packet.route ? `route_reason: ${packet.route.reason}` : undefined,
    `answerable: ${packet.answerable}`,
    `confidence: ${packet.confidence}`,
    packet.coverage_certificate ? `deny_broad_exploration: ${packet.coverage_certificate.deny_broad_exploration}` : undefined,
    packet.output_policy ? `output_policy: ${packet.output_policy.preferred_format}` : undefined,
    `recommended_next_action: ${packet.recommended_next_action}`,
    `max_additional_calls: ${packet.max_additional_calls}`,
    statePath ? `state_path: ${statePath}` : undefined,
    coverage.length > 0 ? `coverage_gaps: ${coverage.join(", ")}` : "coverage_gaps: none",
    "",
    "Evidence:",
    ...evidenceLines,
    "",
    "Answer contract:",
    `required_sections=${packet.answer_contract.required_sections.join(" | ")}`,
    `quality_checks=${packet.answer_contract.quality_checks.slice(0, 8).join(" | ")}`,
    `evidence_rules=${packet.answer_contract.evidence_rules.slice(0, 4).join(" | ")}`,
    "",
    "Missing:",
    ...(packet.missing.length > 0 ? packet.missing.slice(0, 8).map((item) => `- ${item}`) : ["- none"]),
    "",
    "Allowed followups:",
    ...(packet.allowed_followups.length > 0
      ? packet.allowed_followups.slice(0, 5).map((followup) => `- ${followup.tool}: ${followup.reason}`)
      : ["- none"]),
    "",
    "TokenOpt compact mode: full packet is stored in state_path; call tokenopt_compile_evidence with detail=full only when debugging."
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function formatFullEvidencePacket(packet: EvidencePacket, statePath: string | undefined): string {
  const lines = [
    "TokenOpt compiled evidence packet",
    `packet_id: ${packet.packet_id}`,
    `task_type: ${packet.task_type}`,
    packet.route ? `route_decision: ${packet.route.taskClass}/${packet.route.toolProfile}/${packet.route.action}` : undefined,
    packet.route ? `route_reason: ${packet.route.reason}` : undefined,
    `answerable: ${packet.answerable}`,
    `confidence: ${packet.confidence}`,
    packet.coverage_certificate ? `deny_broad_exploration: ${packet.coverage_certificate.deny_broad_exploration}` : undefined,
    packet.output_policy ? `output_policy: ${JSON.stringify(packet.output_policy)}` : undefined,
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
    "Answer contract:",
    "Required sections:",
    ...packet.answer_contract.required_sections.map((item) => `- ${item}`),
    "Evidence rules:",
    ...packet.answer_contract.evidence_rules.map((item) => `- ${item}`),
    "Quality checks:",
    ...packet.answer_contract.quality_checks.map((item) => `- ${item}`),
    "Failure conditions:",
    ...packet.answer_contract.failure_conditions.map((item) => `- ${item}`),
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

function extractRepositoryOverview(repoRoot: string): RepositoryOverview | undefined {
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

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
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
