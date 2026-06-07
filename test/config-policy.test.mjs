import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
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
