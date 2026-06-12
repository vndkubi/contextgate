import assert from "node:assert/strict";
import test from "node:test";
import { buildSuiteRouteMetadata } from "../dist/suite-benchmark.js";

test("suite benchmark metadata reports acquisition mode and contract", () => {
  const metadata = buildSuiteRouteMetadata(
    "Tracebug OrderService.java:42 failing test OrderServiceTest.shouldRejectMissingPartition",
    "investigate",
    {
      finalAnswer: "acquisition_mode: direct_narrow\nevidence_contract: trace_proof\nevidence_contract_pass: false",
      mcpCalls: 1,
      shellCalls: 0
    }
  );

  assert.equal(metadata.acquisitionMode, "direct_narrow");
  assert.equal(metadata.evidenceContract, "trace_proof");
  assert.equal(metadata.evidenceContractPass, false);
  assert.equal(metadata.doubleSpend, false);
});

test("suite benchmark metadata flags direct-narrow double spend", () => {
  const metadata = buildSuiteRouteMetadata(
    "Tracebug OrderService.java:42 failing test OrderServiceTest.shouldRejectMissingPartition",
    "investigate",
    {
      finalAnswer: "Used repo-wide rg --files after packet acquisition.",
      mcpCalls: 1,
      shellCalls: 1
    }
  );

  assert.equal(metadata.acquisitionMode, "direct_narrow");
  assert.equal(metadata.doubleSpend, true);
});
