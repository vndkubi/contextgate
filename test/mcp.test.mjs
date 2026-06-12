import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withTokenOptMcp(callback, options = {}) {
  const artifactDir = options.artifactDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-mcp-artifacts-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "mcp"],
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {}),
      TOKENOPT_ARTIFACT_DIR: artifactDir
    }
  });
  const client = new Client({ name: "tokenopt-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

test("mcp exposes TokenOpt gated tools", async () => {
  await withTokenOptMcp(async (client) => {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "tokenopt_compile_evidence",
      "tokenopt_read_file",
      "tokenopt_search"
    ]);

    const hidden = await client.callTool({
      name: "tokenopt_run_command",
      arguments: { command: "echo hidden" }
    });
    assert.equal(hidden.isError ?? false, true);
    assert.match(hidden.content[0].text, /not exposed in lite mode/);
  });
});

test("mcp full mode exposes command and project facts tools", async () => {
  await withTokenOptMcp(
    async (client) => {
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "tokenopt_assemble_spring_context",
        "tokenopt_business_contract",
        "tokenopt_compile_evidence",
        "tokenopt_failure_packet",
        "tokenopt_impact_analysis",
        "tokenopt_jakarta_annotation_filter",
        "tokenopt_prepare_java_diff",
        "tokenopt_project_facts",
        "tokenopt_read_file",
        "tokenopt_run_command",
        "tokenopt_search",
        "tokenopt_symbol_packet",
        "tokenopt_symbols_find",
        "tokenopt_test_neighbors",
        "tokenopt_tracebug_packet"
      ]);
    },
    { env: { TOKENOPT_MCP_MODE: "full" } }
  );
});

test("mcp full mode runs coding coverage tools", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-coding-mcp-repo-"));
  fs.mkdirSync(path.join(repo, "src", "orders"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test", "orders"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "coding-mcp", scripts: { test: "vitest run" } }, null, 2));
  fs.writeFileSync(
    path.join(repo, "src", "orders", "OrderService.ts"),
    [
      "import { OrderRepository } from './OrderRepository';",
      "export class OrderService {",
      "  constructor(private repo: OrderRepository) {}",
      "  authorizePayment(orderId: string): boolean {",
      "    if (!orderId) throw new Error('missing order');",
      "    return this.repo.find(orderId).status === 'ready';",
      "  }",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "test", "orders", "OrderService.test.ts"),
    "import { describe, it, expect, vi } from 'vitest';\ndescribe('OrderService', () => { it('works', () => { expect(vi.fn()).toBeDefined(); }); });\n"
  );

  await withTokenOptMcp(
    async (client) => {
      const symbols = await client.callTool({
        name: "tokenopt_symbols_find",
        arguments: { query: "OrderService", cwd: repo }
      });
      assert.equal(symbols.isError ?? false, false);
      assert.match(symbols.content[0].text, /OrderService/);

      const packet = await client.callTool({
        name: "tokenopt_symbol_packet",
        arguments: { query: "OrderService", cwd: repo }
      });
      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /TokenOpt symbol packet/);
      assert.match(packet.content[0].text, /Nearby tests:/);

      const neighbors = await client.callTool({
        name: "tokenopt_test_neighbors",
        arguments: { target: "src/orders/OrderService.ts", cwd: repo }
      });
      assert.equal(neighbors.isError ?? false, false);
      assert.match(neighbors.content[0].text, /OrderService\.test\.ts/);

      const failure = await client.callTool({
        name: "tokenopt_failure_packet",
        arguments: { output: "src/orders/OrderService.ts(4,8): error TS2304: Cannot find name 'OrderStatus'.", cwd: repo }
      });
      assert.equal(failure.isError ?? false, false);
      assert.match(failure.content[0].text, /failure_kind: typescript/);
      assert.match(failure.content[0].text, /OrderService\.ts/);

      const tracebug = await client.callTool({
        name: "tokenopt_tracebug_packet",
        arguments: {
          query: "Tracebug missing order failure in OrderService.authorizePayment",
          output: "Error: missing order\n    at OrderService.authorizePayment (src/orders/OrderService.ts:4:11)",
          cwd: repo
        }
      });
      assert.equal(tracebug.isError ?? false, false);
      assert.match(tracebug.content[0].text, /TokenOpt tracebug packet/);
      assert.match(tracebug.content[0].text, /status: grounded/);
      assert.match(tracebug.content[0].text, /src\/orders\/OrderService\.ts/);
      assert.equal(tracebug.structuredContent.packet.answerability.canAnswer, true);
    },
    { cwd: repo, env: { TOKENOPT_MCP_MODE: "full" } }
  );
});

test("mcp compile evidence uses coding coverage for unit-test tasks", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-coding-evidence-repo-"));
  fs.mkdirSync(path.join(repo, "src", "orders"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "coding-evidence", scripts: { test: "vitest run" } }, null, 2));
  fs.writeFileSync(
    path.join(repo, "src", "orders", "OrderService.ts"),
    [
      "export class OrderService {",
      "  authorizePayment(orderId: string): boolean {",
      "    return Boolean(orderId);",
      "  }",
      "}"
    ].join("\n")
  );

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Write unit tests for OrderService",
          task_type: "write_unittest",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });
      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /route_decision: coding_coverage\/coding\/compile/);
      assert.match(packet.content[0].text, /answerable: false/);
      assert.match(packet.content[0].text, /target_symbol: covered/);
      assert.match(packet.content[0].text, /existing_test_neighbor: missing/);
      assert.match(packet.content[0].text, /tokenopt_symbol_packet/);
      assert.equal(packet.structuredContent.packetSummary.route.taskClass, "coding_coverage");
      assert.equal(packet.structuredContent.packetSummary.answerable, false);
      assert.equal(packet.structuredContent.packetSummary.max_additional_calls <= 1, true);
      assert.equal(packet.structuredContent.packetSummary.allowed_followups.length <= 1, true);
      assert.equal(packet.structuredContent.packetSummary.allowed_followups.some((followup) => followup.tool === "tokenopt_symbol_packet"), true);
    },
    { cwd: repo, env: { TOKENOPT_MCP_MODE: "full" } }
  );
});

test("mcp compile evidence bypasses missing-artifact tasks before repo inventory", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-missing-artifact-repo-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "missing-artifact-fixture" }, null, 2));

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Analyze a requirement and produce WHAT, WHY, HOW, acceptance criteria, impacted areas, tests, and unknowns. Return JSON.",
          task_type: "unknown",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /route_decision: needs_input_bypass\/bypass\/bypass/);
      assert.match(packet.content[0].text, /recommended_next_action: ask_user/);
      assert.match(packet.content[0].text, /max_additional_calls: 0/);
      assert.match(packet.content[0].text, /repo_inventory=skipped/);
      assert.doesNotMatch(packet.content[0].text, /total_files=/);
      assert.equal(packet.structuredContent.packetSummary.answerable, false);
      assert.equal(packet.structuredContent.packetSummary.recommended_next_action, "ask_user");
      assert.equal(packet.structuredContent.packetSummary.max_additional_calls, 0);
      assert.equal(packet.structuredContent.packetSummary.route.taskClass, "needs_input_bypass");
    },
    { cwd: repo }
  );
});

test("mcp compile evidence returns security coverage contract without scope", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-security-audit-repo-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "security-audit-fixture" }, null, 2));

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Perform a security-focused review of changed behavior or risky surfaces. Return JSON findings.",
          task_type: "review_diff",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /route_decision: security_audit\/security\/compile/);
      assert.match(packet.content[0].text, /answerable: false/);
      assert.match(packet.content[0].text, /target_or_diff_known: missing/);
      assert.match(packet.content[0].text, /auth_authz_checked: missing/);
      assert.match(packet.content[0].text, /recommended_next_action: ask_user/);
      assert.match(packet.content[0].text, /deny_broad_exploration: true/);
      assert.equal(packet.structuredContent.packetSummary.route.taskClass, "security_audit");
      assert.equal(packet.structuredContent.packetSummary.answerable, false);
      assert.equal(packet.structuredContent.packetSummary.coverage_certificate.dimensions.target_or_diff_known, "missing");
      assert.equal(packet.structuredContent.packetSummary.max_additional_calls, 0);
    },
    { cwd: repo }
  );
});

test("mcp compile evidence returns generic review packet for C diff with related context", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-review-c-repo-"));
  const fuseDir = path.join(repo, "hadoop-hdfs-project", "hadoop-hdfs-native-client", "src", "main", "native", "fuse-dfs");
  fs.mkdirSync(fuseDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "review-c-fixture" }, null, 2));
  fs.writeFileSync(
    path.join(fuseDir, "fuse_impls_open.c"),
    [
      "int dfs_open(const char *path, struct fuse_file_info *fi) {",
      "  int flags = O_WRONLY;",
      "  if ((flags & O_ACCMODE) == O_WRONLY) {",
      "    fh->buf = NULL;",
      "  } else {",
      "    fh->buf = malloc(32768);",
      "  }",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(path.join(fuseDir, "fuse_file_handle.h"), "typedef struct dfs_fh_struct { char *buf; } dfs_fh;\n");

  const diff = [
    "Review this C diff",
    "diff --git a/hadoop-hdfs-project/hadoop-hdfs-native-client/src/main/native/fuse-dfs/fuse_impls_flush.c b/hadoop-hdfs-project/hadoop-hdfs-native-client/src/main/native/fuse-dfs/fuse_impls_flush.c",
    "--- a/hadoop-hdfs-project/hadoop-hdfs-native-client/src/main/native/fuse-dfs/fuse_impls_flush.c",
    "+++ b/hadoop-hdfs-project/hadoop-hdfs-native-client/src/main/native/fuse-dfs/fuse_impls_flush.c",
    "@@ -36,14 +36,18 @@",
    " int dfs_flush(const char *path, struct fuse_file_info *fi) {",
    "-  if (fi->flags & O_WRONLY) {",
    "-    if (hdfsFlush(hdfsConnGetFs(fh->conn), file_handle) != 0) {",
    "+  // fi->flags is not reliable in flush(); it may be 0.",
    "+  ",
    "+  if (fh->buf == NULL) {",
    "+    if (hdfsHFlush(hdfsConnGetFs(fh->conn), file_handle) != 0) {",
    "       return -EIO;",
    "     }",
    "   }",
    " }"
  ].join("\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: diff,
          task_type: "review_diff",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /answerable: true/);
      assert.match(packet.content[0].text, /evidence_contract_pass: true/);
      assert.match(packet.content[0].text, /changed_symbols=.*dfs_flush/);
      assert.match(packet.content[0].text, /added_calls=.*hdfsHFlush/);
      assert.match(packet.content[0].text, /removed_calls=.*hdfsFlush/);
      assert.match(packet.content[0].text, /line_level_finding=trailing_whitespace/);
      assert.match(packet.content[0].text, /fuse_impls_open\.c:\d+:.*fh->buf = NULL/);
      assert.equal(packet.structuredContent.packetSummary.answerable, true);
      assert.equal(packet.structuredContent.packetSummary.max_additional_calls, 0);
    },
    { cwd: repo }
  );
});

test("mcp review packet emits config effective-policy recall probe", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-review-config-probe-"));
  const sourceDir = path.join(repo, "src", "main", "java", "org", "apache", "hadoop", "hdfs", "server", "blockmanagement");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "review-config-probe" }, null, 2));
  fs.writeFileSync(
    path.join(sourceDir, "HeartbeatManager.java"),
    [
      "class HeartbeatManager {",
      "  private volatile long heartbeatRecheckInterval;",
      "  HeartbeatManager(boolean avoidStaleDataNodesForWrite, long staleInterval, long recheckInterval) {",
      "    if (avoidStaleDataNodesForWrite && staleInterval < recheckInterval) {",
      "      this.heartbeatRecheckInterval = staleInterval;",
      "    } else {",
      "      this.heartbeatRecheckInterval = recheckInterval;",
      "    }",
      "  }",
      "  void setHeartbeatRecheckInterval(long interval) {",
      "    heartbeatRecheckInterval = interval;",
      "  }",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(sourceDir, "DatanodeManager.java"),
    [
      "class DatanodeManager {",
      "  private int heartbeatRecheckInterval;",
      "  private HeartbeatManager heartbeatManager;",
      "  private void setHeartbeatInterval(long intervalSeconds, int recheckInterval) {",
      "    this.heartbeatRecheckInterval = recheckInterval;",
      "    heartbeatManager.setHeartbeatRecheckInterval(heartbeatRecheckInterval);",
      "  }",
      "}"
    ].join("\n")
  );

  const diff = [
    "Review this heartbeat reconfiguration diff",
    "diff --git a/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/DatanodeManager.java b/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/DatanodeManager.java",
    "--- a/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/DatanodeManager.java",
    "+++ b/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/DatanodeManager.java",
    "@@ -4,6 +4,7 @@ private void setHeartbeatInterval(long intervalSeconds, int recheckInterval) {",
    "     this.heartbeatRecheckInterval = recheckInterval;",
    "+    heartbeatManager.setHeartbeatRecheckInterval(heartbeatRecheckInterval);",
    "   }",
    "diff --git a/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/HeartbeatManager.java b/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/HeartbeatManager.java",
    "--- a/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/HeartbeatManager.java",
    "+++ b/src/main/java/org/apache/hadoop/hdfs/server/blockmanagement/HeartbeatManager.java",
    "@@ -8,6 +8,9 @@ class HeartbeatManager {",
    "+  void setHeartbeatRecheckInterval(long interval) {",
    "+    heartbeatRecheckInterval = interval;",
    "+  }"
  ].join("\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: diff,
          task_type: "review_diff",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /recall_probe=config_effective_policy_invariant/);
      assert.match(packet.content[0].text, /technical_finding_candidate=true/);
      assert.match(packet.content[0].text, /severity_hint=P2/);
      assert.match(packet.content[0].text, /Raw heartbeatRecheckInterval is pushed into HeartbeatManager/);
      assert.match(packet.content[0].text, /staleInterval < recheckInterval/);
      assert.equal(packet.structuredContent.packetSummary.answerable, true);
    },
    { cwd: repo }
  );
});

test("mcp review packet emits parser encoding recall probe", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-review-parser-probe-"));
  const sourceDir = path.join(repo, "x-pack", "plugin", "core", "src", "main", "java", "org", "elasticsearch", "xpack", "core", "security", "support");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "review-parser-probe" }, null, 2));
  fs.writeFileSync(
    path.join(sourceDir, "Automatons.java"),
    [
      "class Automatons {",
      "  private static Automaton literalStringUnion(List<BytesRef> refs) {",
      "    return Automata.makeStringUnion(refs);",
      "  }",
      "  private static Automaton buildAutomatonWithLiteralPartition(Collection<String> patterns) {",
      "    final BytesRef ref = (pattern.isEmpty() == false && isLiteralPattern(pattern)) ? new BytesRef(pattern) : null;",
      "    return literalStringUnion(refs);",
      "  }",
      "  static Automaton wildcard(String text) {",
      "    for (int i = 0; i < text.length(); i++) {",
      "      automata.add(Automata.makeChar(text.charAt(i)));",
      "    }",
      "    return Operations.concatenate(automata);",
      "  }",
      "}"
    ].join("\n")
  );

  const diff = [
    "Review this security privilege automaton diff",
    "diff --git a/x-pack/plugin/core/src/main/java/org/elasticsearch/xpack/core/security/support/Automatons.java b/x-pack/plugin/core/src/main/java/org/elasticsearch/xpack/core/security/support/Automatons.java",
    "--- a/x-pack/plugin/core/src/main/java/org/elasticsearch/xpack/core/security/support/Automatons.java",
    "+++ b/x-pack/plugin/core/src/main/java/org/elasticsearch/xpack/core/security/support/Automatons.java",
    "@@ -1,5 +1,12 @@",
    "+  private static Automaton literalStringUnion(List<BytesRef> refs) {",
    "+    return Automata.makeStringUnion(refs);",
    "+  }",
    "+  private static Automaton buildAutomatonWithLiteralPartition(Collection<String> patterns) {",
    "+    final BytesRef ref = (pattern.isEmpty() == false && isLiteralPattern(pattern)) ? new BytesRef(pattern) : null;",
    "+    return literalStringUnion(refs);",
    "+  }"
  ].join("\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: diff,
          task_type: "review_diff",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /recall_probe=parser_encoding_language_equivalence/);
      assert.match(packet.content[0].text, /technical_finding_candidate=true/);
      assert.match(packet.content[0].text, /severity_hint=P2/);
      assert.match(packet.content[0].text, /BytesRef\/makeStringUnion compiles literal strings through UTF-8 bytes/);
      assert.match(packet.content[0].text, /Automata\.makeChar/);
      assert.equal(packet.structuredContent.packetSummary.answerable, true);
    },
    { cwd: repo }
  );
});

test("mcp compile evidence returns direct-narrow tracebug packet without inventory", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-tracebug-direct-repo-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "tracebug-direct-fixture" }, null, 2));

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Tracebug OrderService.java:42 failing test OrderServiceTest.shouldRejectMissingPartition",
          task_type: "investigate",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /route_decision: exact_symbol\/exact\/exact_route/);
      assert.match(packet.content[0].text, /acquisition_mode: direct_narrow/);
      assert.match(packet.content[0].text, /evidence_contract: trace_proof/);
      assert.match(packet.content[0].text, /repo_inventory=skipped/);
      assert.doesNotMatch(packet.content[0].text, /total_files=/);
      assert.equal(packet.structuredContent.packetSummary.acquisition_mode, "direct_narrow");
      assert.equal(packet.structuredContent.packetSummary.evidence_contract, "trace_proof");
      assert.equal(packet.structuredContent.packetSummary.evidence_contract_pass, false);
      assert.equal(packet.structuredContent.packetSummary.max_additional_calls, 1);
    },
    { cwd: repo, env: { TOKENOPT_MCP_MODE: "full" } }
  );
});

test("mcp compile evidence asks for tracebug artifact when missing", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-tracebug-missing-repo-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "tracebug-missing-fixture" }, null, 2));

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "tracebug this issue",
          task_type: "investigate",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /route_decision: needs_input_bypass\/bypass\/bypass/);
      assert.match(packet.content[0].text, /acquisition_mode: ask_or_bypass/);
      assert.match(packet.content[0].text, /recommended_next_action: ask_user/);
      assert.match(packet.content[0].text, /max_additional_calls: 0/);
      assert.match(packet.content[0].text, /repo_inventory=skipped/);
      assert.equal(packet.structuredContent.packetSummary.acquisition_mode, "ask_or_bypass");
      assert.equal(packet.structuredContent.packetSummary.evidence_contract, "artifact_sufficiency");
      assert.equal(packet.structuredContent.packetSummary.max_additional_calls, 0);
    },
    { cwd: repo }
  );
});

test("mcp falls back to bounded node scanner when rg and git are unavailable", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-no-rg-repo-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "no-rg-fixture" }, null, 2));
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const NeedleValue = 42;\n");

  await withTokenOptMcp(
    async (client) => {
      const facts = await client.callTool({
        name: "tokenopt_project_facts",
        arguments: { cwd: repo }
      });
      assert.equal(facts.isError ?? false, false);
      assert.match(facts.content[0].text, /searchProvider: node/);
      assert.match(facts.content[0].text, /totalFiles:/);

      const search = await client.callTool({
        name: "tokenopt_search",
        arguments: { pattern: "NeedleValue", cwd: repo }
      });
      assert.equal(search.isError ?? false, false);
      assert.match(search.content[0].text, /searchProvider: node/);
      assert.match(search.content[0].text, /src\/index\.ts:1:export const NeedleValue = 42;/);
    },
    {
      cwd: repo,
      env: {
        TOKENOPT_MCP_MODE: "full",
        PATH: "",
        Path: ""
      }
    }
  );
});

test("mcp replaces broad command with bounded inventory", async () => {
  await withTokenOptMcp(
    async (client) => {
      const result = await client.callTool({
        name: "tokenopt_run_command",
        arguments: { command: "rg --files", cwd: process.cwd() }
      });
      assert.equal(result.isError ?? false, false);
      assert.match(result.content[0].text, /TokenOpt replaced a raw repo-wide file listing/);
      assert.match(result.content[0].text, /totalFiles:/);
      assert.match(result.content[0].text, /rawArtifact:/);
    },
    { env: { TOKENOPT_MCP_MODE: "full" } }
  );
});

test("mcp compiles business deep-dive evidence and gates grep fallback", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-business-repo-"));
  fs.mkdirSync(path.join(repo, "src", "checkout"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: "merchant-platform",
        version: "1.0.0",
        scripts: { test: "vitest run" }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(repo, "README.md"),
    [
      "# Merchant Platform",
      "",
      "Merchant Platform helps online merchants manage catalog, checkout, payment authorization, order fulfillment, and customer support workflows from one operational system.",
      "",
      "## Product capabilities",
      "",
      "The system coordinates catalog publishing, cart checkout, payment capture, refunds, order status, and fulfillment events."
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "docs", "business.md"),
    [
      "# Business model",
      "",
      "Merchants use the platform to reduce manual order operations and give customers a reliable checkout and fulfillment experience.",
      "",
      "## Checkout and payments",
      "## Fulfillment operations",
      "## Customer support"
    ].join("\n")
  );
  fs.writeFileSync(path.join(repo, "src", "checkout", "PaymentService.ts"), "export class PaymentService {}\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "study business and deep dive that business and explain detail for me",
          cwd: repo,
          detail: "full",
          quality_rubric: ["explain what why how", "identify users", "map business to project areas"]
        }
      });
      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /task_type: research_business/);
      assert.match(packet.content[0].text, /answerable: true/);
      assert.match(packet.content[0].text, /business_purpose=Merchant Platform helps online merchants/);
      assert.match(packet.content[0].text, /likely_users=.*business users\/customers/);
      assert.match(packet.content[0].text, /final_answer_sections=What this business\/product is/);
      assert.match(packet.content[0].text, /Answer contract:/);
      assert.match(packet.content[0].text, /What the business\/product is/);
      assert.match(packet.content[0].text, /Maps capabilities to code\/project areas/);
      assert.match(packet.content[0].text, /shell_grep/);

      const gated = await client.callTool({
        name: "tokenopt_run_command",
        arguments: { command: "grep -R checkout src", cwd: repo }
      });
      assert.equal(gated.isError ?? false, false);
      assert.match(gated.content[0].text, /TokenOpt answerability gate/);
    },
    { cwd: repo, env: { TOKENOPT_MCP_MODE: "full" } }
  );
});

test("mcp does not mark target-specific business task answerable without target evidence", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-target-business-repo-"));
  fs.mkdirSync(path.join(repo, "src", "orders"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "merchant-platform", version: "1.0.0", scripts: { test: "vitest run" } }, null, 2)
  );
  fs.writeFileSync(
    path.join(repo, "README.md"),
    [
      "# Merchant Platform",
      "",
      "Merchant Platform helps online merchants manage catalog, checkout, payment authorization, order fulfillment, and customer support workflows from one operational system."
    ].join("\n")
  );
  fs.writeFileSync(path.join(repo, "src", "orders", "OrderService.ts"), "export class OrderService {}\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "study returns business and deep dive that business and explain detail for me",
          cwd: repo,
          detail: "full",
          quality_rubric: ["explain target-specific business evidence"]
        }
      });
      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /task_type: research_business/);
      assert.match(packet.content[0].text, /answerable: false/);
      assert.match(packet.content[0].text, /target_specific_evidence: missing/);
      assert.match(packet.content[0].text, /Target-specific evidence missing for: returns/);
      assert.match(packet.content[0].text, /tokenopt_search: Find evidence tied to the exact requested target/);
    },
    { cwd: repo }
  );
});

test("mcp compiles existing flow packet for diagramming and routes fallback to TokenOpt followups", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-flow-repo-"));
  fs.mkdirSync(path.join(repo, "src", "checkout"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test", "checkout"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: "checkout-flow-fixture",
        version: "1.0.0",
        scripts: { test: "vitest run" }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(repo, "README.md"),
    "Checkout Flow Fixture\n\nThis repository models a checkout flow for carts, payment authorization, and order confirmation.\n"
  );
  fs.writeFileSync(path.join(repo, "src", "checkout", "CheckoutController.ts"), "export class CheckoutController {}\n");
  fs.writeFileSync(path.join(repo, "src", "checkout", "CheckoutService.ts"), "export class CheckoutService {}\n");
  fs.writeFileSync(path.join(repo, "test", "checkout", "CheckoutFlow.test.ts"), "test('checkout flow', () => {});\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Understand checkout flow end-to-end so I can draw Mermaid sequence diagram and explain business",
          cwd: repo,
          detail: "full",
          quality_rubric: ["actors and trigger", "step-by-step call chain", "business state changes", "mermaid diagram"]
        }
      });
      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /task_type: api_flow/);
      assert.match(packet.content[0].text, /answerable: false/);
      assert.match(packet.content[0].text, /flow_target=checkout flow/);
      assert.match(packet.content[0].text, /candidate_entrypoints=.*CheckoutController\.ts/);
      assert.match(packet.content[0].text, /candidate_services=.*CheckoutService\.ts/);
      assert.match(packet.content[0].text, /candidate_tests=.*CheckoutFlow\.test\.ts/);
      assert.match(packet.content[0].text, /Mermaid sequenceDiagram or flowchart/);
      assert.match(packet.content[0].text, /Answer contract:/);
      assert.match(packet.content[0].text, /Each flow edge must cite a matched file\/symbol/);
      assert.match(packet.content[0].text, /Includes valid Mermaid syntax/);
      assert.match(packet.content[0].text, /tokenopt_search: Find exact references/);

      const search = await client.callTool({
        name: "tokenopt_search",
        arguments: { pattern: "CheckoutService", cwd: repo }
      });
      assert.equal(search.isError ?? false, false);
      assert.match(search.content[0].text, /TokenOpt search summary/);
    },
    { cwd: repo }
  );
});

test("mcp compile evidence defaults to compact output and summary structured content", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-compact-repo-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "compact-fixture", version: "1.0.0", scripts: { test: "vitest run" } }, null, 2)
  );
  fs.writeFileSync(path.join(repo, "README.md"), "Compact Fixture\n\nThis repository demonstrates compact TokenOpt evidence output for build handoff tasks.\n");
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const value = 1;\n");

  await withTokenOptMcp(
    async (client) => {
      const compact = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Prepare a daily build handoff for this repo",
          task_type: "build_handoff",
          cwd: repo,
          quality_rubric: ["identify build tool", "list scripts"]
        }
      });
      const full = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Prepare a daily build handoff for this repo",
          task_type: "build_handoff",
          cwd: repo,
          detail: "full",
          include_structured_packet: true,
          quality_rubric: ["identify build tool", "list scripts"]
        }
      });

      assert.equal(compact.isError ?? false, false);
      assert.equal(full.isError ?? false, false);
      assert.match(compact.content[0].text, /TokenOpt evidence packet compact/);
      assert.ok(compact.content[0].text.length < full.content[0].text.length);
      assert.ok(compact.content[0].text.length < 4000);
      assert.equal(compact.structuredContent.packet, undefined);
      assert.equal(compact.structuredContent.packetSummary.answerable, true);
      assert.equal(full.structuredContent.packet.answerable, true);
    },
    { cwd: repo }
  );
});

test("mcp compile evidence strips pasted benchmark instruction text from task", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-sanitize-task-repo-"));
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "sanitize-fixture", version: "1.0.0", scripts: { test: "vitest run" } }, null, 2)
  );
  fs.writeFileSync(path.join(repo, "README.md"), "Payments business coordinates authorization, capture, refunds, and settlement.\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task:
            "study payments business and deepdive study that business. Explain concepts and glossary.\n" +
            "Project instruction injected by TokenOpt setup:\n" +
            "The user may ask naturally and does not need to name MCP tools.\n" +
            "When TokenOpt MCP tools are available, use tokenopt_compile_evidence first.",
          task_type: "research_business",
          cwd: repo,
          detail: "full",
          include_structured_packet: true
        }
      });

      assert.equal(packet.isError ?? false, false);
      assert.equal(
        packet.structuredContent.packet.task,
        "study payments business and deepdive study that business. Explain concepts and glossary."
      );
      assert.doesNotMatch(packet.structuredContent.packet.task, /Project instruction injected/);
    },
    { cwd: repo }
  );
});

test("mcp compiles answerable evidence and gates redundant exploration", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-evidence-repo-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: "evidence-fixture",
        version: "1.2.3",
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "vitest run"
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const value = 1;\n");

  await withTokenOptMcp(
    async (client) => {
      const packet = await client.callTool({
        name: "tokenopt_compile_evidence",
        arguments: {
          task: "Prepare a daily build handoff for this repo",
          task_type: "build_handoff",
          cwd: repo,
          detail: "full",
          quality_rubric: ["identify build tool", "list scripts"]
        }
      });
      assert.equal(packet.isError ?? false, false);
      assert.match(packet.content[0].text, /answerable: true/);
      assert.match(packet.content[0].text, /build_tool=Npm/);
      assert.match(packet.content[0].text, /npm_scripts=build,test/);

      const gated = await client.callTool({
        name: "tokenopt_search",
        arguments: { pattern: "value", cwd: repo }
      });
      assert.equal(gated.isError ?? false, false);
      assert.match(gated.content[0].text, /TokenOpt answerability gate/);
      assert.match(gated.content[0].text, /answer now/);
    },
    { cwd: repo }
  );
});
