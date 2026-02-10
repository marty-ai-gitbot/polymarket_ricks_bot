import assert from "node:assert/strict";
import test from "node:test";

import { buildEnvOverrides, parseArgs } from "./cli.js";

test("parseArgs defaults to server", () => {
  const args = parseArgs([]);
  assert.equal(args.runMode, "server");
  assert.equal(args.port, undefined);
});

test("parseArgs supports once with mode + selector", () => {
  const args = parseArgs(["--once", "--mode", "paper", "--selector", "top_volume"]);
  assert.equal(args.runMode, "once");
  assert.equal(args.tradingMode, "paper");
  assert.equal(args.selector, "top_volume");
});

test("parseArgs supports ticks with interval", () => {
  const args = parseArgs(["--ticks", "3", "--interval-ms", "1500"]);
  assert.equal(args.runMode, "ticks");
  assert.equal(args.ticks, 3);
  assert.equal(args.intervalMs, 1500);
});

test("parseArgs rejects invalid mode", () => {
  assert.throws(() => parseArgs(["--mode", "nope"]), /Invalid --mode/);
});

test("parseArgs rejects invalid selector", () => {
  assert.throws(() => parseArgs(["--selector", "random"]), /Invalid --selector/);
});

test("buildEnvOverrides maps paper + selector", () => {
  const overrides = buildEnvOverrides({
    runMode: "once",
    tradingMode: "paper",
    selector: "easy_targets"
  });
  assert.equal(overrides.PAPER, "true");
  assert.equal(overrides.LIVE, "false");
  assert.equal(overrides.DRY_RUN, "true");
  assert.equal(overrides.TARGETS_MODE, "easy_targets");
});

test("buildEnvOverrides maps live", () => {
  const overrides = buildEnvOverrides({ runMode: "once", tradingMode: "live" });
  assert.equal(overrides.PAPER, "false");
  assert.equal(overrides.LIVE, "true");
  assert.equal(overrides.DRY_RUN, "false");
});
