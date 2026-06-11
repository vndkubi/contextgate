import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { writeEvidenceTaskState } from "../dist/evidence-state.js";
import { compressText } from "../dist/log-compressor.js";
import { readRepoEvents } from "../dist/observability.js";
import { evaluatePolicy } from "../dist/policy-core.js";
import { routeTask } from "../dist/router.js";

test("router classifies review, debug, refactor, exact, and small-repo bypass tasks", () => {
  assert.equal(routeTask({ task: "Review this PR diff for changed files" }).taskClass, "review_diff");
  assert.equal(routeTask({ task: "Debug this Spring stack trace Caused by NullPointerException" }).taskClass, "coding_coverage");
  assert.equal(routeTask({ task: "Implement validation in OrderService" }).taskClass, "coding_coverage");
  assert.equal(routeTask({ task: "Write unit tests for OrderService" }).taskClass, "coding_coverage");
  assert.equal(routeTask({ task: "Refactor OrderService to extract validation" }).taskClass, "refactor_scope");
  assert.equal(routeTask({ task: "Find usages of PaymentGateway.authorize" }).taskClass, "exact_symbol");

  const small = routeTask({
    task: "Inspect src/orders/OrderService.ts and explain the risk",
    repoFileCount: 42
  });
  assert.equal(small.taskClass, "small_repo_bypass");
  assert.equal(small.action, "bypass");
});

test("shadow answerability gate logs would-deny without blocking", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-shadow-policy-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-shadow-artifacts-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "shadow-fixture" }));
  const loaded = loadConfig({
    cwd: repo,
    env: {
      ...process.env,
      TOKENOPT_ARTIFACT_DIR: artifactDir,
      TOKENOPT_ANSWERABILITY_GATE: "shadow"
    }
  });
  writeEvidenceTaskState(loaded.config, loaded.repoRoot, {
    packet_id: "packet-shadow",
    task: "Prepare a daily build handoff",
    task_type: "build_handoff",
    repo_root: loaded.repoRoot,
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
      budget_tokens: 1600,
      evidence_tokens_est: 100,
      response_tokens_est: 400
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
      toolInput: { command: "grep -R shadow src" },
      raw: {}
    },
    loaded.config,
    { repoRoot: loaded.repoRoot }
  );

  assert.equal(decision.action, "context");
  assert.match(decision.reason, /shadow gate would deny/);
  assert.equal(decision.metadata.shadowGate.wouldDeny, true);

  const events = readRepoEvents(loaded.config, loaded.repoRoot);
  assert.equal(events.some((event) => event.eventName === "shadow-gate" && event.metadata.shadowGate.taskId === "packet-shadow"), true);
});

test("compressText applies Java trace and build log compressors", () => {
  const javaTrace = [
    "java.lang.IllegalStateException: failed to start",
    "\tat com.acme.orders.OrderService.load(OrderService.java:42)",
    "\tat org.springframework.aop.framework.CglibAopProxy.invoke(CglibAopProxy.java:123)",
    "\tat org.springframework.cglib.proxy.MethodProxy.invoke(MethodProxy.java:99)",
    "\tat org.hibernate.engine.spi.ActionQueue.execute(ActionQueue.java:88)",
    "Caused by: java.lang.NullPointerException: missing order",
    "\tat com.acme.orders.OrderRepository.find(OrderRepository.java:17)",
    "\tat java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)"
  ].join("\n");
  const traceResult = compressText(javaTrace, 2000);
  assert.equal(traceResult.kind, "java-trace");
  assert.match(traceResult.text, /Caused by: java\.lang\.NullPointerException/);
  assert.match(traceResult.text, /OrderService\.java:42/);
  assert.match(traceResult.text, /framework\/internal frames collapsed/);

  const buildLog = [
    "Downloading from central: https://repo.maven.apache.org/maven2/example.jar",
    "Progress (1): 10 kB",
    "[ERROR] COMPILATION ERROR :",
    "[ERROR] /src/main/java/App.java:[12,8] cannot find symbol",
    "Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
    "BUILD FAILURE"
  ].join("\n");
  const buildResult = compressText(buildLog, 2000);
  assert.equal(buildResult.kind, "build-log");
  assert.match(buildResult.text, /BUILD FAILURE/);
  assert.match(buildResult.text, /cannot find symbol/);
  assert.doesNotMatch(buildResult.text, /Downloading from central/);
});
