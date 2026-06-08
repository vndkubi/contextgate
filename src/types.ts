export type TokenOptHookEventName =
  | "user-prompt-submit"
  | "pre-tool-use"
  | "post-tool-use"
  | "pre-compact";

export type TokenOptSource = "codex" | "mcp";

export type PolicyAction = "allow" | "deny" | "rewrite" | "context" | "compress";

export type BroadSearchMode = "deny" | "warn";
export type ExpensiveTestMode = "allow" | "warn" | "rewrite";
export type EvidenceTaskType =
  | "api_flow"
  | "field_impact"
  | "review_diff"
  | "startup_flow"
  | "investigate"
  | "research_business"
  | "implement"
  | "write_unittest"
  | "build_handoff"
  | "unknown";
export type EvidenceCoverageStatus = "covered" | "partial" | "missing";
export type EvidenceNextAction = "answer_now" | "expand_exact" | "targeted_shell" | "ask_user";

export interface TokenOptConfig {
  version: 1;
  policy: {
    enabled: boolean;
    maxFileReadBytes: number;
    maxCommandOutputChars: number;
    denyGeneratedReads: boolean;
    denyLockfileReads: boolean;
    broadSearch: {
      mode: BroadSearchMode;
      maxResults: number;
    };
    expensiveTests: {
      mode: ExpensiveTestMode;
      patterns: string[];
      targetedHint: string;
    };
  };
  context: {
    enableSecretBlock: boolean;
    userPromptGuidance: string;
  };
  paths: {
    artifactDir?: string;
  };
  codex: {
    installScope: "user" | "repo";
  };
  codegraph: {
    enabled: boolean;
    mcpServer?: string;
  };
}

export interface LoadedConfig {
  config: TokenOptConfig;
  repoRoot: string;
  userConfigPath: string;
  repoConfigPath: string;
  loadedPaths: string[];
}

export interface TokenOptEvent {
  source: TokenOptSource;
  eventName: TokenOptHookEventName;
  cwd: string;
  sessionId?: string;
  turnId?: string;
  permissionMode?: string;
  transcriptPath?: string | null;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  prompt?: string;
  trigger?: string;
  raw: unknown;
}

export interface PolicyRuntime {
  repoRoot: string;
  tokenoptCommand?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  reason?: string;
  systemMessage?: string;
  additionalContext?: string;
  updatedInput?: unknown;
  replacementText?: string;
  estimatedTokensSaved?: number;
  shouldPersistRaw?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CompressionResult {
  kind: "vitest" | "jest" | "pytest" | "tsc" | "eslint" | "generic";
  text: string;
  originalChars: number;
  compressedChars: number;
  estimatedTokensSaved: number;
}

export interface EvidenceItem {
  id: string;
  claim: string;
  files?: string[];
  facts?: string[];
  snippet?: string;
  tokens_est?: number;
}

export interface EvidenceFollowup {
  tool: string;
  reason: string;
  args?: Record<string, unknown>;
  max_output_tokens?: number;
}

export interface EvidencePacket {
  packet_id: string;
  task: string;
  task_type: EvidenceTaskType;
  repo_root: string;
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  evidence: EvidenceItem[];
  missing: string[];
  allowed_followups: EvidenceFollowup[];
  disallowed_followups: string[];
  recommended_next_action: EvidenceNextAction;
  max_additional_calls: number;
  token_budget: {
    budget_tokens: number;
    evidence_tokens_est: number;
    response_tokens_est: number;
  };
  created_at: string;
  expires_at: string;
}

export interface EvidenceTaskState {
  packet: EvidencePacket;
  stored_at: string;
}

export interface ObservabilityEvent {
  timestamp: string;
  source: TokenOptSource | "cli";
  eventName: string;
  repoRoot: string;
  action: PolicyAction | "exec" | "audit" | "install" | "doctor" | "evidence";
  reason?: string;
  toolName?: string;
  command?: string;
  artifactPath?: string;
  estimatedTokensSaved?: number;
  metadata?: Record<string, unknown>;
}
