import "dotenv/config";

import { loadEnv } from "./config/env.js";
import { createLogger } from "./log/logger.js";
import { JsonlStore } from "./store/jsonl_store.js";
import { PolymarketClobClient } from "./polymarket/clob_client.js";
import { GammaClient } from "./polymarket/gamma_client.js";
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
  const gamma = new GammaClient(env.POLYMARKET_GAMMA_BASE_URL);
  const clob = new PolymarketClobClient(env.POLYMARKET_CLOB_BASE_URL);
  const paper = new PaperEngine(store, log);

  const markets = await gamma.listMarkets(200);
  log.info("gamma markets fetched", { count: markets.length });

  // v0: pick top volume and snapshot orderbooks for the YES token (if present)
  const ranked = [...markets]
    .filter(m => m.active)
    .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
    .slice(0, env.MAX_MARKETS_TO_ANALYZE);

  for (const m of ranked) {
    const yes = m.tokens.find(t => t.outcome.toLowerCase() === "yes") ?? m.tokens[0];
    if (!yes) continue;
    const book = await clob.getOrderBook(yes.token_id);
    store.append("books.jsonl", { t: new Date().toISOString(), market: m, token: yes, book });
  }

  // placeholder: demonstrate an order record
  if (env.PAPER) {
    paper.place({
      t: new Date().toISOString(),
      marketId: ranked[0]?.id ?? "unknown",
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
