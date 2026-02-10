type Level = "debug" | "info" | "warn" | "error";

const rank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: Level) {
  const min = rank[level] ?? rank.info;

  function log(lvl: Level, msg: string, meta?: unknown) {
    if (rank[lvl] < min) return;
    const line = {
      t: new Date().toISOString(),
      lvl,
      msg,
      ...(meta ? { meta } : {})
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }

  return {
    debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
    info: (msg: string, meta?: unknown) => log("info", msg, meta),
    warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
    error: (msg: string, meta?: unknown) => log("error", msg, meta)
  };
}

export type Logger = ReturnType<typeof createLogger>;
