import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { writeEvidenceTaskState } from "../dist/evidence-state.js";
import { evaluatePolicy } from "../dist/policy-core.js";

test("config precedence loads user then repo then env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-config-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(home, ".tokenopt"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".tokenopt"), { recursive: true });
  fs.writeFileSync(path.join(home, ".tokenopt", "config.json"), JSON.stringify({ policy: { maxCommandOutputChars: 111 } }));
  fs.writeFileSync(path.join(repo, ".tokenopt", "config.json"), JSON.stringify({ policy: { maxCommandOutputChars: 222 } }));

  const loaded = loadConfig({
    cwd: repo,
    env: { HOME: home, TOKENOPT_MAX_OUTPUT_CHARS: "333" }
  });

  assert.equal(loaded.config.policy.maxCommandOutputChars, 333);
  assert.deepEqual(loaded.loadedPaths, [
    path.join(home, ".tokenopt", "config.json"),
    path.join(repo, ".tokenopt", "config.json")
  ]);
});

test("pre-tool-use rewrites expensive tests through tokenopt exec", () => {
  const event = {
    source: "codex",
    eventName: "pre-tool-use",
    cwd: process.cwd(),
    toolName: "Bash",
    toolInput: { command: "npm test" },
    raw: {}
  };
  const loaded = loadConfig({ cwd: process.cwd(), env: {} });
  const decision = evaluatePolicy(event, loaded.config, {
    repoRoot: process.cwd(),
    tokenoptCommand: '"node" "cli.js"'
  });

  assert.equal(decision.action, "rewrite");
  assert.deepEqual(decision.updatedInput, { command: '"node" "cli.js" exec -- npm test' });
});

test("pre-tool-use rewrites Gradle and Maven full test commands", () => {
  const loaded = loadConfig({ cwd: process.cwd(), env: {} });
  for (const command of ["./gradlew test", "mvn test"]) {
    const decision = evaluatePolicy(
      {
        source: "codex",
        eventName: "pre-tool-use",
        cwd: process.cwd(),
        toolName: "Bash",
        toolInput: { command },
        raw: {}
      },
      loaded.config,
      {
        repoRoot: process.cwd(),
        tokenoptCommand: '"node" "cli.js"'
      }
    );
    assert.equal(decision.action, "rewrite");
    assert.deepEqual(decision.updatedInput, { command: `"node" "cli.js" exec -- ${command}` });
  }
});

test("user prompt blocks likely secrets", () => {
  const loaded = loadConfig({ cwd: process.cwd(), env: {} });
  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "user-prompt-submit",
      cwd: process.cwd(),
      prompt: "please use sk-abcdefghijklmnopqrstuvwxyz123456",
      raw: {}
    },
    loaded.config,
    { repoRoot: process.cwd() }
  );
  assert.equal(decision.action, "deny");
});

test("user prompt injects TokenOpt MCP routing guidance for natural tasks", () => {
  const loaded = loadConfig({ cwd: process.cwd(), env: {} });
  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "user-prompt-submit",
      cwd: process.cwd(),
      prompt: "please help me write unittest for class OrderService",
      raw: {}
    },
    loaded.config,
    { repoRoot: process.cwd() }
  );
  assert.equal(decision.action, "context");
  assert.match(decision.additionalContext, /tokenopt_compile_evidence/);
  assert.match(decision.additionalContext, /cost gate/);
  assert.match(decision.additionalContext, /MCP\+shell double-spend/);
});

test("mcp lockfile reads are denied", () => {
  const loaded = loadConfig({ cwd: process.cwd(), env: {} });
  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "pre-tool-use",
      cwd: process.cwd(),
      toolName: "mcp__fs__read_file",
      toolInput: { path: "package-lock.json" },
      raw: {}
    },
    loaded.config,
    { repoRoot: process.cwd() }
  );
  assert.equal(decision.action, "deny");
});

test("repo-wide rg file listing is denied", () => {
  const loaded = loadConfig({ cwd: process.cwd(), env: {} });
  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "pre-tool-use",
      cwd: process.cwd(),
      toolName: "Bash",
      toolInput: { command: "rg --files --hidden -g '!/.git/*'" },
      raw: {}
    },
    loaded.config,
    { repoRoot: process.cwd() }
  );
  assert.equal(decision.action, "deny");
});

test("pre-tool-use denies shell grep after answerable evidence packet", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-policy-gate-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-policy-artifacts-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "policy-gate-fixture" }));
  const loaded = loadConfig({ cwd: repo, env: { TOKENOPT_ARTIFACT_DIR: artifactDir } });
  writeEvidenceTaskState(loaded.config, loaded.repoRoot, {
    packet_id: "packet-123",
    task: "study business and deep dive that business",
    task_type: "research_business",
    repo_root: loaded.repoRoot,
    answerable: true,
    confidence: 0.88,
    coverage: {},
    evidence: [],
    missing: [],
    allowed_followups: [],
    disallowed_followups: ["shell_grep"],
    recommended_next_action: "answer_now",
    max_additional_calls: 0,
    token_budget: {
      budget_tokens: 1600,
      evidence_tokens_est: 200,
      response_tokens_est: 700
    },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });

  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "pre-tool-use",
      cwd: repo,
      toolName: "Bash",
      toolInput: { command: "grep -R Needle src" },
      raw: {}
    },
    loaded.config,
    { repoRoot: loaded.repoRoot }
  );

  assert.equal(decision.action, "deny");
  assert.match(decision.reason, /answerability gate blocked shell search/);
  assert.match(decision.reason, /packet-123/);
});

test("pre-tool-use denies shell search after non-answerable packet with TokenOpt followups", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-policy-flow-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-policy-flow-artifacts-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "policy-flow-fixture" }));
  const loaded = loadConfig({ cwd: repo, env: { TOKENOPT_ARTIFACT_DIR: artifactDir } });
  writeEvidenceTaskState(loaded.config, loaded.repoRoot, {
    packet_id: "packet-flow",
    task: "understand checkout flow and draw mermaid diagram",
    task_type: "api_flow",
    repo_root: loaded.repoRoot,
    answerable: false,
    confidence: 0.62,
    coverage: {},
    evidence: [],
    missing: ["Need exact entrypoint."],
    allowed_followups: [
      {
        tool: "tokenopt_search",
        reason: "Find exact flow references.",
        args: { pattern: "checkout", path: "." }
      }
    ],
    disallowed_followups: ["raw_shell_search"],
    recommended_next_action: "expand_exact",
    max_additional_calls: 3,
    token_budget: {
      budget_tokens: 1600,
      evidence_tokens_est: 200,
      response_tokens_est: 250
    },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });

  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "pre-tool-use",
      cwd: repo,
      toolName: "Bash",
      toolInput: { command: "rg checkout src" },
      raw: {}
    },
    loaded.config,
    { repoRoot: loaded.repoRoot }
  );

  assert.equal(decision.action, "deny");
  assert.match(decision.reason, /Use the packet's allowed_followups/);
  assert.match(decision.reason, /packet-flow/);
});
