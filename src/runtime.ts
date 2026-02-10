import { loadEnv } from "./config/env.js";
import { createLogger } from "./log/logger.js";
import { JsonlStore } from "./store/jsonl_store.js";
import { PolymarketClobClient } from "./polymarket/clob_client.js";
import { GammaClient } from "./polymarket/gamma_client.js";
import { PaperEngine } from "./execution/paper_engine.js";

export type Runtime = {
  env: ReturnType<typeof loadEnv>;
  log: ReturnType<typeof createLogger>;
  store: JsonlStore;
  gamma: GammaClient;
  clob: PolymarketClobClient;
  paper: PaperEngine;
};

export function createRuntime(overrides: NodeJS.ProcessEnv = {}): Runtime {
  const env = loadEnv({ ...process.env, ...overrides });
  const log = createLogger(env.LOG_LEVEL as any);
  const store = new JsonlStore("./data");
  const gamma = new GammaClient(env.POLYMARKET_GAMMA_BASE_URL);
  const clob = new PolymarketClobClient(env.POLYMARKET_CLOB_BASE_URL);
  const paper = new PaperEngine(store, log);

  return { env, log, store, gamma, clob, paper };
}
