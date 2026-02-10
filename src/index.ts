import "dotenv/config";

import { createRuntime } from "./runtime.js";
import { runOnce, runTicks } from "./bot.js";
import { startServer } from "./server.js";
import { buildEnvOverrides, parseArgs } from "./cli.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = createRuntime(buildEnvOverrides(args));

  if (runtime.env.LIVE) {
    runtime.log.warn("live mode selected but execution is stubbed", {
      LIVE: runtime.env.LIVE,
      PAPER: runtime.env.PAPER
    });
  }

  if (args.runMode === "once") {
    await runOnce(runtime);
    return;
  }

  if (args.runMode === "ticks") {
    await runTicks(runtime, args.ticks ?? 1, args.intervalMs);
    return;
  }

  startServer(runtime, { port: args.port });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
