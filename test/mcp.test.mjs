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
      "tokenopt_project_facts",
      "tokenopt_read_file",
      "tokenopt_run_command",
      "tokenopt_search"
    ]);
  });
});

test("mcp replaces broad command with bounded inventory", async () => {
  await withTokenOptMcp(async (client) => {
    const result = await client.callTool({
      name: "tokenopt_run_command",
      arguments: { command: "rg --files", cwd: process.cwd() }
    });
    assert.equal(result.isError ?? false, false);
    assert.match(result.content[0].text, /TokenOpt replaced a raw repo-wide file listing/);
    assert.match(result.content[0].text, /totalFiles:/);
    assert.match(result.content[0].text, /rawArtifact:/);
  });
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
