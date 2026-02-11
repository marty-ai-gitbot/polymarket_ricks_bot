import assert from "node:assert/strict";
import { test } from "node:test";

import { compareLiveMarketRows, filterGammaMarkets } from "../src/server.ts";

type Market = {
  id: string;
  slug: string;
  question: string;
  active: boolean;
  resolved?: boolean;
  closed?: boolean;
  endDate?: string | number;
  volumeNum?: number;
  liquidityNum?: number;
  updatedAt?: string;
  tokens: Array<{ token_id: string; outcome: string }>;
};

function baseMarket(overrides: Partial<Market>): Market {
  return {
    id: "mkt",
    slug: "mkt",
    question: "Test market",
    active: true,
    tokens: [],
    ...overrides
  };
}

function baseFilterInput(nowMs: number) {
  return {
    activeOnly: true,
    includeResolved: false,
    nowMs,
    minVolume: null,
    maxSpreadBps: null,
    minLiquidityUsd: null,
    query: "",
    selector: "top_volume",
    slugList: []
  };
}

test("filters resolved and expired markets by default", () => {
  const now = Date.now();
  const markets = [
    baseMarket({ id: "resolved", resolved: true }),
    baseMarket({ id: "expired", endDate: new Date(now - 10_000).toISOString() }),
    baseMarket({ id: "active" })
  ];

  const filtered = filterGammaMarkets(markets, baseFilterInput(now));

  assert.deepEqual(
    filtered.map(m => m.id),
    ["active"]
  );
});

test("includes resolved markets when toggled and activeOnly is false", () => {
  const now = Date.now();
  const markets = [
    baseMarket({ id: "resolved", active: false, resolved: true, endDate: new Date(now + 60_000).toISOString() }),
    baseMarket({ id: "active", active: true })
  ];

  const filtered = filterGammaMarkets(markets, {
    ...baseFilterInput(now),
    activeOnly: false,
    includeResolved: true
  });

  assert.deepEqual(
    filtered.map(m => m.id).sort(),
    ["active", "resolved"]
  );
});

test("activeOnly filters out inactive markets", () => {
  const now = Date.now();
  const markets = [
    baseMarket({ id: "inactive", active: false }),
    baseMarket({ id: "active", active: true })
  ];

  const filtered = filterGammaMarkets(markets, baseFilterInput(now));

  assert.deepEqual(
    filtered.map(m => m.id),
    ["active"]
  );
});

test("volume_desc prefers more recent updatedAt on ties", () => {
  const rowA = {
    market: baseMarket({ id: "a", volumeNum: 10 }),
    spreadBps: null,
    updatedAt: "2024-01-01T00:00:00.000Z"
  };
  const rowB = {
    market: baseMarket({ id: "b", volumeNum: 10 }),
    spreadBps: null,
    updatedAt: "2024-02-01T00:00:00.000Z"
  };

  const result = compareLiveMarketRows(rowA, rowB, "volume_desc");

  assert.ok(result > 0, "newer updatedAt should sort first when volumes tie");
});
