export type CliArgs = {
  runMode: "server" | "once" | "ticks";
  ticks?: number;
  intervalMs?: number;
  port?: number;
  tradingMode?: "paper" | "live";
  selector?: "top_volume" | "easy_targets";
};

type RawArgValue = string | true | undefined;

function parseIntFlag(value: RawArgValue, name: string) {
  if (value === undefined || value === true) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected a number`);
  }
  return parsed;
}

function parsePositiveInt(value: RawArgValue, name: string) {
  const parsed = parseIntFlag(value, name);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value: RawArgValue, name: string) {
  const parsed = parseIntFlag(value, name);
  if (parsed === undefined) return undefined;
  if (parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, RawArgValue>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.split("=", 2);
    if (value !== undefined) {
      args.set(key, value);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }

  let tradingMode: CliArgs["tradingMode"];
  const modeRaw = args.get("--mode");
  if (modeRaw !== undefined) {
    const normalized = String(modeRaw).toLowerCase();
    if (normalized !== "paper" && normalized !== "live") {
      throw new Error("Invalid --mode: expected paper or live");
    }
    tradingMode = normalized as CliArgs["tradingMode"];
  }

  let selector: CliArgs["selector"];
  const selectorRaw = args.get("--selector");
  if (selectorRaw !== undefined) {
    const normalized = String(selectorRaw).toLowerCase();
    if (normalized !== "top_volume" && normalized !== "easy_targets") {
      throw new Error("Invalid --selector: expected top_volume or easy_targets");
    }
    selector = normalized as CliArgs["selector"];
  }

  if (args.has("--once")) {
    return { runMode: "once", tradingMode, selector };
  }

  if (args.has("--ticks")) {
    const ticksRaw = args.get("--ticks");
    const ticks = parsePositiveInt(ticksRaw === true ? "1" : ticksRaw, "--ticks");
    const intervalMs = parseNonNegativeInt(args.get("--interval-ms"), "--interval-ms");
    return { runMode: "ticks", ticks, intervalMs, tradingMode, selector };
  }

  const port = parsePositiveInt(args.get("--port"), "--port");
  return { runMode: "server", port, tradingMode, selector };
}

export function buildEnvOverrides(args: CliArgs): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {};

  if (args.tradingMode === "paper") {
    overrides.PAPER = "true";
    overrides.LIVE = "false";
    overrides.DRY_RUN = "true";
  }

  if (args.tradingMode === "live") {
    overrides.PAPER = "false";
    overrides.LIVE = "true";
    overrides.DRY_RUN = "false";
  }

  if (args.selector) {
    overrides.TARGETS_MODE = args.selector;
  }

  return overrides;
}
