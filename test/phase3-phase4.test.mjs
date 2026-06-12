import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { adaptDecisionToCopilot, normalizeCopilotEvent } from "../dist/copilot-adapter.js";
import { evaluateHardGate } from "../dist/hard-gate.js";
import { buildInstructionGraph } from "../dist/instruction-audit.js";
import { compressText } from "../dist/log-compressor.js";
import { linkBusinessContracts } from "../dist/processors/business-contract-linker.js";
import { analyzeImpact } from "../dist/processors/impact-analysis.js";

function evidenceState(repoRoot) {
  return {
    stored_at: new Date().toISOString(),
    packet: {
      packet_id: "phase3-packet",
      task: "build handoff",
      task_type: "build_handoff",
      repo_root: repoRoot,
      answerable: true,
      confidence: 0.9,
      coverage: { build_system: "covered" },
      evidence: [],
      missing: [],
      allowed_followups: [],
      disallowed_followups: ["shell_grep"],
      recommended_next_action: "answer_now",
      max_additional_calls: 0,
      token_budget: {
        budget_tokens: 1200,
        evidence_tokens_est: 100,
        response_tokens_est: 300
      },
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }
  };
}

test("hard gate module returns deny, shadow, and off decisions", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-hard-gate-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "hard-gate" }));
  for (const [mode, expected] of [["hard", "deny"], ["shadow", "context"], ["off", "allow"]]) {
    const loaded = loadConfig({
      cwd: repo,
      env: {
        ...process.env,
        TOKENOPT_ARTIFACT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-hard-artifacts-")),
        TOKENOPT_ANSWERABILITY_GATE: mode
      }
    });
    const decision = evaluateHardGate({
      config: loaded.config,
      repoRoot: loaded.repoRoot,
      state: evidenceState(loaded.repoRoot),
      toolName: "Bash",
      toolInput: { command: "grep -R Needle src" },
      reason: "test_gate",
      hardReason: "blocked",
      shadowContext: "would block",
      forceWouldDeny: true
    });
    assert.equal(decision.action, expected);
    assert.equal(decision.metadata.hardGateMode, mode);
  }
});

test("compressor v2 handles JSON, review findings, and generic error summaries", () => {
  const json = compressText(JSON.stringify({ status: "failed", error: { message: "bad thing", reason: "missing config" }, items: Array.from({ length: 20 }, (_, id) => ({ id })) }), 2000);
  assert.equal(json.kind, "json-result");
  assert.match(json.text, /missing config/);

  const review = compressText("[P1] src/main/java/App.java:42: missing authorization check. Suggestion: add endpoint-level authorization coverage.", 2000);
  assert.equal(review.kind, "review-findings");
  assert.match(review.text, /src\/main\/java\/App.java/);

  const error = compressText("noise\n".repeat(200) + "Fatal error: failed to start\nCaused by: missing config\n", 2000);
  assert.equal(error.kind, "error-summary");
  assert.match(error.text, /missing config/);
});

test("business contract linker and impact analyzer return scoped evidence", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-impact-"));
  fs.mkdirSync(path.join(repo, "src/main/java/com/acme"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src/test/java/com/acme"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/main/java/com/acme/OrderController.java"), "class OrderController { OrderService service; }\n");
  fs.writeFileSync(path.join(repo, "src/main/java/com/acme/OrderService.java"), "class OrderService { void approve() {} }\n");
  fs.writeFileSync(path.join(repo, "src/test/java/com/acme/OrderServiceTest.java"), "class OrderServiceTest {}\n");
  const repoFiles = [
    "src/main/java/com/acme/OrderController.java",
    "src/main/java/com/acme/OrderService.java",
    "src/test/java/com/acme/OrderServiceTest.java"
  ];

  const contracts = linkBusinessContracts({
    task: "review order approval change",
    changedFiles: ["src/main/java/com/acme/OrderService.java"],
    repoFiles
  });
  assert.equal(contracts.candidates.some((candidate) => candidate.type === "api"), true);
  assert.equal(contracts.candidates.some((candidate) => candidate.type === "test"), true);

  const impact = analyzeImpact({
    repoRoot: repo,
    target: "OrderService",
    changedFiles: ["src/main/java/com/acme/OrderService.java"],
    repoFiles
  });
  assert.equal(impact.definitions.some((item) => item.includes("OrderService.java")), true);
  assert.equal(impact.likelyTests.some((item) => item.endsWith("OrderServiceTest.java")), true);
});

test("Copilot adapter normalizes events and adapts decisions", () => {
  const event = normalizeCopilotEvent({
    hookEventName: "PreToolUse",
    cwd: process.cwd(),
    toolName: "Bash",
    toolInput: { command: "rg --files" }
  });
  assert.equal(event.eventName, "pre-tool-use");
  assert.equal(event.toolName, "Bash");

  const output = adaptDecisionToCopilot("pre-tool-use", {
    action: "deny",
    reason: "blocked"
  });
  assert.deepEqual(output, {
    permissionDecision: "deny",
    permissionDecisionReason: "blocked"
  });
});

test("instruction graph planner emits root and path-specific files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-instruction-graph-"));
  const plan = buildInstructionGraph(repo);
  const files = plan.files.map((file) => file.path.replace(/\\/g, "/"));
  assert.equal(files.some((file) => file.endsWith(".github/copilot-instructions.md")), true);
  assert.equal(files.some((file) => file.endsWith("tokenopt-review.instructions.md")), true);
  assert.equal(files.some((file) => file.endsWith("tokenopt-runtime.instructions.md")), true);
  const reviewInstructions = plan.files.find((file) => file.path.endsWith(path.join(".github", "instructions", "tokenopt-review.instructions.md")));
  assert.match(reviewInstructions.content, /two phases/i);
  assert.match(reviewInstructions.content, /branch pair/);
  assert.match(reviewInstructions.content, /tokenopt_compile_evidence/);
  assert.match(reviewInstructions.content, /Jira\/Confluence MCP tools/);
  assert.match(reviewInstructions.content, /relevant attachments/);
  assert.match(reviewInstructions.content, /Do not ask the user to paste full content/);
  assert.match(reviewInstructions.content, /business\/test coverage review/);
  assert.match(reviewInstructions.content, /effective config\/policy math/);
  assert.match(reviewInstructions.content, /ISTQB dimensions/);
  assert.match(reviewInstructions.content, /user provides a review checklist/);
  assert.match(reviewInstructions.content, /pass, fail, gap, or not_applicable/);
  assert.ok(plan.totalEstimatedTokens > 0);
});
