import type { Runtime } from "./runtime.js";

export type RunOnceResult = {
  marketsFetched: number;
  marketsAnalyzed: number;
  booksWritten: number;
  ordersWritten: number;
};

function selectMarkets(
  markets: any[],
  mode: string,
  limit: number,
  targetSlugs?: string
) {
  const active = markets.filter(m => m.active);
  if (mode === "easy_targets") {
    return [...active]
      .sort((a, b) => (a.volumeNum ?? 0) - (b.volumeNum ?? 0))
      .slice(0, limit);
  }
  if (mode === "slugs") {
    const slugs = String(targetSlugs ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (slugs.length === 0) return [];
    return active.filter(m => slugs.includes(String(m.slug ?? m.id)));
  }
  return [...active]
    .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
    .slice(0, limit);
}

export async function runOnce(runtime: Runtime): Promise<RunOnceResult> {
  const { env, log, store, gamma, clob, paper } = runtime;

  log.info("tick start", {
    DRY_RUN: env.DRY_RUN,
    PAPER: env.PAPER,
    LIVE: env.LIVE,
    TARGETS_MODE: env.TARGETS_MODE,
    MAX_MARKETS_TO_ANALYZE: env.MAX_MARKETS_TO_ANALYZE
  });

  const markets = await gamma.listMarkets(200);
  log.info("gamma markets fetched", { count: markets.length });

  const ranked = selectMarkets(
    markets as any[],
    env.TARGETS_MODE,
    env.MAX_MARKETS_TO_ANALYZE,
    env.TARGET_SLUGS
  );

  let booksWritten = 0;
  for (const m of ranked) {
    const tokens = Array.isArray(m.tokens) ? m.tokens : [];
    const yes =
      tokens.find((t: any) => String(t?.outcome ?? "").toLowerCase() === "yes") ??
      tokens[0];
    if (!yes) continue;
    try {
      const book = await clob.getOrderBook(yes.token_id);
      store.append("books.jsonl", { t: new Date().toISOString(), market: m, token: yes, book });
      booksWritten += 1;
    } catch (err) {
      log.warn("orderbook fetch failed", { marketId: m.id, err: String(err) });
    }
  }

  let ordersWritten = 0;
  if (env.PAPER) {
    paper.place({
      t: new Date().toISOString(),
      marketId: ranked[0]?.id ?? "unknown",
      side: "buy_yes",
      price: 0.5,
      sizeUsd: 1,
      reason: "smoke test"
    });
    ordersWritten = 1;
  } else {
    log.warn("PAPER disabled; skipping paper order");
  }

  log.info("tick done", { marketsAnalyzed: ranked.length, booksWritten, ordersWritten });

  return {
    marketsFetched: markets.length,
    marketsAnalyzed: ranked.length,
    booksWritten,
    ordersWritten
  };
}

export async function runTicks(runtime: Runtime, count: number, intervalMs = 5000) {
  const total = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const wait = Number.isFinite(intervalMs) ? Math.max(0, Math.floor(intervalMs)) : 0;

  for (let i = 0; i < total; i += 1) {
    await runOnce(runtime);
    if (i < total - 1 && wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
