import test from "node:test";
import assert from "node:assert/strict";

import { PolymarketClobClient } from "./clob_client.js";

test("CLOB getOrderBook builds request", async () => {
  const client = new PolymarketClobClient("https://clob.polymarket.com");

  // Mock global fetch
  const calls: string[] = [];
  // @ts-expect-error - test override
  global.fetch = async (url: any) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({ bids: [{ price: "0.4", size: "10" }], asks: [{ price: "0.6", size: "5" }] })
    } as any;
  };

  const book = await client.getOrderBook("123");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("/book"));
  assert.ok(calls[0].includes("token_id=123"));
  assert.equal(book.bids[0].price, 0.4);
});
