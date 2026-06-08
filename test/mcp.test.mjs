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
        "tokenopt_compile_evidence",
        "tokenopt_project_facts",
        "tokenopt_read_file",
        "tokenopt_run_command",
        "tokenopt_search"
      ]);
    },
    { env: { TOKENOPT_MCP_MODE: "full" } }
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
