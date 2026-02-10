import "dotenv/config";

import { loadEnv } from "./config/env.js";
import { createLogger } from "./log/logger.js";
import { JsonlStore } from "./store/jsonl_store.js";
import { PolymarketClobClient } from "./polymarket/clob_client.js";
import { PaperEngine } from "./execution/paper_engine.js";

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL as any);

  log.info("boot", {
    DRY_RUN: env.DRY_RUN,
    PAPER: env.PAPER,
    LIVE: env.LIVE,
    TARGETS_MODE: env.TARGETS_MODE,
    MAX_MARKETS_TO_ANALYZE: env.MAX_MARKETS_TO_ANALYZE
  });

  const store = new JsonlStore("./data");
  const clob = new PolymarketClobClient(env.POLYMARKET_CLOB_BASE_URL);
  const paper = new PaperEngine(store, log);

  const markets = await clob.listMarkets();
  log.info("markets fetched", { count: markets.length });

  // v0: just pick top volume and log snapshots (no trading yet)
  const ranked = [...markets]
    .filter(m => m.active !== false)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, env.MAX_MARKETS_TO_ANALYZE);

  for (const m of ranked) {
    const book = await clob.getOrderBook(m.conditionId);
    store.append("books.jsonl", { t: new Date().toISOString(), market: m, book });
  }

  // placeholder: demonstrate an order record
  if (env.PAPER) {
    paper.place({
      t: new Date().toISOString(),
      marketId: ranked[0]?.conditionId ?? "unknown",
      side: "buy_yes",
      price: 0.5,
      sizeUsd: 1,
      reason: "smoke test"
    });
  }

  log.info("done");
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
