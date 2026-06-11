import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileCodingCoverageEvidence } from "../dist/coding/coverage-contract.js";
import { parseFailurePacket } from "../dist/coding/failure-packet.js";
import { buildSymbolPacket, findCodingSymbols } from "../dist/coding/symbol-index.js";
import { findTestNeighbors } from "../dist/coding/test-neighbors.js";

function makeCodingFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-coding-fixture-"));
  fs.mkdirSync(path.join(repo, "src", "orders"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test", "orders"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backend", "src", "main", "java", "com", "acme"), { recursive: true });
  fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "orders", "OrderService.ts"),
    [
      "import { OrderRepository } from './OrderRepository';",
      "",
      "export class OrderService {",
      "  constructor(private repo: OrderRepository) {}",
      "",
      "  authorizePayment(orderId: string): boolean {",
      "    if (!orderId) throw new Error('missing order');",
      "    return this.repo.find(orderId).status === 'ready';",
      "  }",
      "}",
      "",
      "export function normalizeOrderId(value: string): string {",
      "  return value.trim();",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "test", "orders", "OrderService.test.ts"),
    [
      "import { describe, expect, it, vi } from 'vitest';",
      "import { OrderService } from '../../src/orders/OrderService';",
      "",
      "describe('OrderService', () => {",
      "  it('authorizes ready orders', () => {",
      "    const repo = { find: vi.fn(() => ({ status: 'ready' })) };",
      "    expect(new OrderService(repo).authorizePayment('o1')).toBe(true);",
      "  });",
      "});"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "backend", "src", "main", "java", "com", "acme", "PaymentGateway.java"),
    [
      "package com.acme;",
      "import java.util.UUID;",
      "public class PaymentGateway {",
      "  public boolean authorize(UUID id) {",
      "    return id != null;",
      "  }",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "pkg", "integrations.py"),
    [
      "class IntegrationBase:",
      "    def register(self, key: str) -> None:",
      "        if not key:",
      "            raise ValueError('missing key')",
      "",
      "def normalize_key(value: str) -> str:",
      "    return value.strip()"
    ].join("\n")
  );
  return repo;
}

test("regex-lite symbol scanner extracts TS, Java, and Python symbols", () => {
  const repo = makeCodingFixture();
  const orderSymbols = findCodingSymbols({ repoRoot: repo, query: "OrderService authorizePayment" });
  assert.equal(orderSymbols.some((symbol) => symbol.name === "OrderService" && symbol.kind === "class"), true);
  assert.equal(orderSymbols.some((symbol) => symbol.name === "authorizePayment" && symbol.kind === "method"), true);

  const javaSymbols = findCodingSymbols({ repoRoot: repo, query: "PaymentGateway authorize" });
  assert.equal(javaSymbols.some((symbol) => symbol.name === "PaymentGateway" && symbol.language === "java"), true);
  assert.equal(javaSymbols.some((symbol) => symbol.name === "authorize" && symbol.kind === "method"), true);

  const pythonSymbols = findCodingSymbols({ repoRoot: repo, query: "IntegrationBase normalize_key" });
  assert.equal(pythonSymbols.some((symbol) => symbol.name === "IntegrationBase" && symbol.language === "python"), true);
  assert.equal(pythonSymbols.some((symbol) => symbol.name === "normalize_key" && symbol.kind === "function"), true);
});

test("symbol packet includes definition, dependencies, callers, callees, and nearby tests", () => {
  const repo = makeCodingFixture();
  const packet = buildSymbolPacket({ repoRoot: repo, query: "OrderService" });
  assert.ok(packet);
  assert.equal(packet.symbol.name, "OrderService");
  assert.match(packet.definition_slice.text, /authorizePayment/);
  assert.equal(packet.dependencies.includes("OrderRepository"), true);
  assert.equal(packet.nearby_tests.includes("test/orders/OrderService.test.ts"), true);
  assert.equal(packet.coverage.nearby_tests, "covered");
});

test("test neighbor finder maps source files to test style and mocking hints", () => {
  const repo = makeCodingFixture();
  const neighbors = findTestNeighbors({ repoRoot: repo, target: "src/orders/OrderService.ts", symbolName: "OrderService" });
  assert.deepEqual(neighbors.test_files, ["test/orders/OrderService.test.ts"]);
  assert.equal(neighbors.framework_hints.some((hint) => /vitest/.test(hint)), true);
  assert.equal(neighbors.mocking_hints.some((hint) => /vi\.mock|vi\.fn/.test(hint)), true);
  assert.equal(neighbors.coverage.existing_test_neighbor, "covered");
});

test("failure packet extracts compiler and test failure locations", () => {
  const packet = parseFailurePacket({
    output: [
      "src/orders/OrderService.ts(6,12): error TS2304: Cannot find name 'OrderStatus'.",
      "[ERROR] backend/src/main/java/App.java:[12,8] cannot find symbol",
      "File \"pkg/integrations.py\", line 4, in register"
    ].join("\n")
  });
  assert.equal(packet.errors.length, 3);
  assert.equal(packet.failure_kind, "typescript");
  assert.equal(packet.suggested_slices.some((slice) => slice.file === "src/orders/OrderService.ts"), true);
});

test("coding coverage contract prevents early answerability when exact coverage is missing", () => {
  const repo = makeCodingFixture();
  const result = compileCodingCoverageEvidence({
    repoRoot: repo,
    task: "Write unit tests for UnknownBillingService",
    taskType: "write_unittest",
    firstEvidenceIndex: 5,
    hasBuildFacts: true,
    codingToolsAvailable: true
  });
  assert.ok(result);
  assert.equal(result.answerable, false);
  assert.equal(result.coverage.target_symbol, "missing");
  assert.equal(result.allowedFollowups.some((followup) => followup.tool === "tokenopt_symbols_find"), true);
});
