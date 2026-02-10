import { JsonlStore } from "../store/jsonl_store.js";
import type { Logger } from "../log/logger.js";

export type PaperOrder = {
  t: string;
  marketId: string;
  side: "buy_yes" | "buy_no";
  price: number;
  sizeUsd: number;
  reason: string;
};

export class PaperEngine {
  constructor(
    private readonly store: JsonlStore,
    private readonly log: Logger
  ) {}

  place(order: PaperOrder) {
    this.store.append("orders.jsonl", order);
    this.log.info("paper order", order);
  }
}
