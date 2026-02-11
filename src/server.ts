import fs from "node:fs";
import path from "node:path";

import http from "node:http";
import { URL } from "node:url";

import type { Runtime } from "./runtime.js";
import { runOnce, runTicks } from "./bot.js";
import type { GammaMarket } from "./polymarket/gamma_client.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HealthState = "connected" | "offline" | "unknown" | "rate_limited";

type Summary = {
  status: {
    running: boolean;
    mode: "paper" | "live";
    paperOnly: boolean;
    selector: string;
    intervalMs: number;
    lastRunTime: string | null;
  };
  stats: {
    marketsAnalyzedToday: number;
    openPositions: number;
    totalPnl: number;
  };
  llm: {
    costToday: number;
    costHour: number;
    budgetDay: number;
    budgetHour: number;
    remainingDay: number;
    remainingHour: number;
  };
  strategy: {
    bankrollUsd: number;
    maxPositionUsd: number;
    riskPercent: number;
    fractionalKelly: number;
    spreadFilter: string;
    depthFilter: string;
  };
  risk: {
    settings: {
      kellyFraction: number;
      maxPosUsd: number;
      maxDailyLossUsd: number;
      maxPositions: number;
      spreadBps: number;
      minDepthUsd: number;
    };
    effective: {
      kellyCapUsd: number;
      maxPosUsd: number;
      maxPosPct: number;
      maxDailyLossUsd: number;
      maxDailyLossPct: number;
      maxPositions: number;
      spreadBps: number;
      minDepthUsd: number;
    };
    tight: {
      kellyFraction: boolean;
      maxPosUsd: boolean;
      maxDailyLossUsd: boolean;
      maxPositions: boolean;
      spreadBps: boolean;
      minDepthUsd: boolean;
    };
  };
  selection: {
    mode: string;
    lastSelectionTime: string | null;
  };
  health: {
    gamma: HealthState;
    clob: HealthState;
    clobDetail?: string | null;
    openai: HealthState;
    uptimeSec: number;
    memoryMb: number;
    dataFiles: {
      count: number;
      totalLines: number;
    };
  };
};

type MarketSnapshot = {
  id: string;
  slug: string;
  question: string;
  volume: number | null;
  spread: number | null;
  midpoint: number | null;
  updatedAt: string | null;
};

type LiveMarketSnapshot = {
  id: string;
  slug: string;
  title: string;
  volume: number | null;
  liquidityUsd: number | null;
  spread: number | null;
  spreadBps: number | null;
  midpoint: number | null;
  updatedAt: string | null;
};

type LiveMarketsStatus = "ok" | "partial" | "rate_limited" | "offline" | "empty";

type LiveMarketsResponse = {
  totalCount: number;
  items: LiveMarketSnapshot[];
  status: LiveMarketsStatus;
  updatedAt: string;
  error?: string;
  cached?: boolean;
  ageMs?: number;
};

type LiveMarketsSort = "volume_desc" | "volume_asc" | "spread_asc" | "updated_desc";

type MarketFilterFlags = {
  activeOnly: boolean;
  includeResolved: boolean;
};

type MarketFilterInput = MarketFilterFlags & {
  nowMs: number;
  minVolume: number | null;
  maxSpreadBps: number | null;
  minLiquidityUsd: number | null;
  query: string;
  selector: string;
  slugList: string[];
};

type PositionSnapshot = {
  id: string;
  marketId: string;
  market: string;
  side: string;
  sizeUsd: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  pnl: number | null;
  updatedAt: string | null;
};

type AnalysisSnapshot = {
  id: string;
  market: string;
  probability: number | null;
  confidence: number | null;
  rationale: string;
  tokens: number | null;
  cost: number | null;
  updatedAt: string | null;
};

type ActivityItem = {
  id: string;
  time: string;
  type: "Analysis" | "Trade" | "Cost" | "Error" | "Info";
  description: string;
  value?: string;
  source: string;
  ts: number;
};

type ActionRequest = {
  action:
    | "run_once"
    | "run_ticks"
    | "stop"
    | "reset"
    | "set_mode"
    | "set_selector"
    | "close_all"
    | "set_risk_params";
  value?: string | number | null;
  ticks?: number | null;
  intervalMs?: number | null;
  slugs?: string | null;
  kellyFraction?: number | string | null;
  maxPosUsd?: number | string | null;
  maxDailyLossUsd?: number | string | null;
  maxPositions?: number | string | null;
  spreadBps?: number | string | null;
  minDepthUsd?: number | string | null;
};

const DATA_DIR = path.resolve("./data");
const FILES = {
  books: "books.jsonl",
  orders: "orders.jsonl",
  executions: "executions.jsonl",
  paper: "paper_engine.jsonl",
  analyses: "analyses.jsonl",
  costs: "costs.jsonl",
  llmCosts: "llm_costs.jsonl",
  selector: "selector.jsonl",
  events: "events.jsonl"
};
const UI_SETTINGS_FILE = "ui_settings.json";
const PAPER_ONLY = true;

const state = {
  running: false,
  mode: "paper" as "paper" | "live",
  selector: "top_volume",
  intervalMs: 8000,
  lastRunTime: null as string | null,
  loopTimer: null as NodeJS.Timeout | null,
  loopInFlight: false
};

const GAMMA_MARKETS_TTL_MS = 10000;
const GAMMA_MARKETS_LIMIT = 1000;
const CLOB_SUMMARY_TTL_MS = 15000;
const CLOB_HEALTH_TTL_MS = 45000;
const CLOB_HEALTH_TIMEOUT_MS = 1500;

type GammaCacheEntry = { fetchedAt: number; items: GammaMarket[] };
const gammaMarketsCache = new Map<string, GammaCacheEntry>();
const gammaMarketsInFlight = new Map<string, Promise<GammaMarket[]>>();
const clobSummaryCache = new Map<
  string,
  {
    fetchedAt: number;
    midpoint: number | null;
    spread: number | null;
    spreadBps: number | null;
  }
>();

const healthCache = {
  gamma: { status: "unknown" as HealthState, checkedAt: 0 },
  clob: { status: "unknown" as HealthState, checkedAt: 0, reason: null as string | null },
  openai: { status: "unknown" as HealthState, checkedAt: 0 }
};

type UiRiskSettings = {
  kellyFraction: number;
  maxPosUsd: number;
  maxDailyLossUsd: number;
  maxPositions: number;
  spreadBps: number;
  minDepthUsd: number;
  updatedAt: string;
};

let cachedUiSettings: UiRiskSettings | null = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultUiSettings(runtime: Runtime): UiRiskSettings {
  const bankroll = runtime.env.BANKROLL_USD;
  return {
    kellyFraction: runtime.env.FRACTIONAL_KELLY,
    maxPosUsd: runtime.env.MAX_RISK_PER_MARKET_USD,
    maxDailyLossUsd: Math.max(0, bankroll * 0.05),
    maxPositions: 3,
    spreadBps: 25,
    minDepthUsd: 200,
    updatedAt: new Date().toISOString()
  };
}

function clampNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeUiSettings(runtime: Runtime, input: Partial<UiRiskSettings>): UiRiskSettings {
  const fallback = defaultUiSettings(runtime);
  const kellyFraction = clampNumber(safeNumber(input.kellyFraction, fallback.kellyFraction), 0, 1);
  const maxPosUsd = clampNonNegative(safeNumber(input.maxPosUsd, fallback.maxPosUsd));
  const maxDailyLossUsd = clampNonNegative(
    safeNumber(input.maxDailyLossUsd, fallback.maxDailyLossUsd)
  );
  const maxPositions = Math.max(0, Math.floor(safeNumber(input.maxPositions, fallback.maxPositions)));
  const spreadBps = clampNonNegative(safeNumber(input.spreadBps, fallback.spreadBps));
  const minDepthUsd = clampNonNegative(safeNumber(input.minDepthUsd, fallback.minDepthUsd));
  return {
    kellyFraction,
    maxPosUsd,
    maxDailyLossUsd,
    maxPositions,
    spreadBps,
    minDepthUsd,
    updatedAt: new Date().toISOString()
  };
}

function loadUiSettings(runtime: Runtime) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, UI_SETTINGS_FILE);
  if (!fs.existsSync(filePath)) {
    const defaults = defaultUiSettings(runtime);
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UiRiskSettings>;
    return normalizeUiSettings(runtime, parsed);
  } catch {
    const defaults = defaultUiSettings(runtime);
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
}

function persistUiSettings(runtime: Runtime, update: Partial<UiRiskSettings>) {
  const current = cachedUiSettings ?? loadUiSettings(runtime);
  const next = normalizeUiSettings(runtime, { ...current, ...update });
  cachedUiSettings = next;
  const filePath = path.join(DATA_DIR, UI_SETTINGS_FILE);
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  runtime.env.FRACTIONAL_KELLY = next.kellyFraction;
  runtime.env.MAX_RISK_PER_MARKET_USD = next.maxPosUsd;
  return next;
}

function getUiSettings(runtime: Runtime) {
  if (!cachedUiSettings) {
    cachedUiSettings = loadUiSettings(runtime);
    runtime.env.FRACTIONAL_KELLY = cachedUiSettings.kellyFraction;
    runtime.env.MAX_RISK_PER_MARKET_USD = cachedUiSettings.maxPosUsd;
  }
  return cachedUiSettings;
}

function safeNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function safeString(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function parseBooleanParam(value: string | null, fallback: boolean) {
  if (value == null || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      if (numeric <= 0) return null;
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function getMarketEndDateMs(market: GammaMarket): number | null {
  if (market.endDate == null) return null;
  return parseTimestampMs(market.endDate);
}

function isMarketResolved(market: GammaMarket) {
  if (market.resolved === true) return true;
  if (market.closed === true) return true;
  return false;
}

function formatCurrency(value: number) {
  const sign = value < 0 ? "-" : "";
  return sign + "$" + Math.abs(value).toFixed(2);
}

function formatPercent(value: number) {
  return value.toFixed(1) + "%";
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfHour() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return { lines: [] as string[], entries: [] as JsonValue[] };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
  const entries: JsonValue[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ parse_error: true, raw: line } as JsonValue);
    }
  }
  return { lines, entries };
}

function readAllJsonl(dir: string) {
  if (!fs.existsSync(dir)) return [] as { file: string; entries: JsonValue[] }[];
  const files = fs.readdirSync(dir).filter(file => file.endsWith(".jsonl"));
  return files.map(file => {
    const full = path.join(dir, file);
    const { entries } = readJsonl(full);
    return { file, entries };
  });
}

function parseTimestamp(entry: JsonValue, fallback = 0) {
  if (entry && typeof entry === "object") {
    const obj = entry as Record<string, JsonValue>;
    const raw = obj.t ?? obj.ts ?? obj.time ?? obj.timestamp ?? obj.created_at ?? obj.createdAt;
    if (raw) {
      const parsed = Date.parse(String(raw));
      if (!Number.isNaN(parsed)) return parsed;
      const numeric = safeNumber(raw, NaN);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return fallback;
}

function lastTimestamp(entries: JsonValue[]) {
  let max = 0;
  for (const entry of entries) {
    const ts = parseTimestamp(entry, 0);
    if (ts > max) max = ts;
  }
  return max > 0 ? new Date(max).toISOString() : null;
}

function sumBy(entries: JsonValue[], keys: string[]) {
  let total = 0;
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, JsonValue>;
      for (const key of keys) {
        if (obj[key] !== undefined) {
          total += safeNumber(obj[key], 0);
          break;
        }
      }
    }
  }
  return total;
}

function pickNumber(obj: Record<string, JsonValue>, keys: string[]) {
  for (const key of keys) {
    if (obj[key] !== undefined) {
      const value = safeNumber(obj[key], NaN);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function extractPnlValue(entry: JsonValue) {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, JsonValue>;
  const totalKeys = ["totalPnl", "total_pnl", "netPnl", "net_pnl", "pnl", "profit"];
  const realizedKeys = ["realizedPnl", "realized_pnl", "realized"];
  const unrealizedKeys = [
    "unrealizedPnl",
    "unrealized_pnl",
    "unrealized",
    "floatingPnl",
    "markToMarket",
    "mtm"
  ];
  const total = pickNumber(obj, totalKeys);
  if (total != null) return total;
  const realized = pickNumber(obj, realizedKeys);
  const unrealized = pickNumber(obj, unrealizedKeys);
  if (realized != null || unrealized != null) {
    return (realized ?? 0) + (unrealized ?? 0);
  }
  return null;
}

type PnlPoint = { t: number; value: number };

function buildPnlSeries(entries: JsonValue[], since: number, until: number) {
  const points: PnlPoint[] = [];
  let prior: PnlPoint | null = null;
  for (const entry of entries) {
    const ts = parseTimestamp(entry, 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const value = extractPnlValue(entry);
    if (value == null || !Number.isFinite(value)) continue;
    if (ts < since) {
      if (!prior || ts > prior.t) {
        prior = { t: ts, value };
      }
      continue;
    }
    if (ts > until) continue;
    points.push({ t: ts, value });
  }
  points.sort((a, b) => a.t - b.t);
  if (prior && (points.length === 0 || prior.t < points[0].t)) {
    points.unshift(prior);
  }
  const deduped: PnlPoint[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.t === point.t) {
      last.value = point.value;
      continue;
    }
    deduped.push({ ...point });
  }
  const maxPoints = 240;
  if (deduped.length <= maxPoints) return deduped;
  const stride = Math.ceil(deduped.length / maxPoints);
  const sampled: PnlPoint[] = [];
  for (let i = 0; i < deduped.length; i += stride) {
    sampled.push(deduped[i]);
  }
  const last = deduped[deduped.length - 1];
  if (sampled[sampled.length - 1]?.t !== last.t) sampled.push(last);
  return sampled;
}

function computeDrawdown(points: PnlPoint[]) {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;
  for (const point of points) {
    if (point.value > peak) {
      peak = point.value;
      continue;
    }
    const dd = peak - point.value;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return maxDrawdown;
}

function valueAtOrBefore(points: PnlPoint[], ts: number) {
  let candidate: PnlPoint | null = null;
  for (const point of points) {
    if (point.t <= ts) candidate = point;
    else break;
  }
  return candidate;
}

function computePnlStats(points: PnlPoint[], since: number, until: number) {
  if (points.length === 0) {
    return {
      current: 0,
      dailyChange: 0,
      drawdown: 0,
      low: 0,
      high: 0,
      rangeStart: new Date(since).toISOString(),
      rangeEnd: new Date(until).toISOString()
    };
  }
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.value < low) low = point.value;
    if (point.value > high) high = point.value;
  }
  const current = points[points.length - 1].value;
  const drawdown = computeDrawdown(points);
  const dailyAnchor = valueAtOrBefore(points, until - 24 * 60 * 60 * 1000) ?? points[0];
  const dailyChange = current - (dailyAnchor?.value ?? 0);
  return {
    current,
    dailyChange,
    drawdown,
    low: Number.isFinite(low) ? low : current,
    high: Number.isFinite(high) ? high : current,
    rangeStart: new Date(points[0].t).toISOString(),
    rangeEnd: new Date(points[points.length - 1].t).toISOString()
  };
}

function resolvePnlRange(rangeRaw: string | null) {
  const value = String(rangeRaw || "").toLowerCase();
  if (value === "24h") return { label: "24h", ms: 24 * 60 * 60 * 1000 };
  if (value === "7d") return { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 };
  if (value === "30d") return { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 };
  return { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 };
}

function classifyApiError(err: unknown): { status: LiveMarketsStatus; message: string } {
  const raw = String(err ?? "");
  const message = raw.length > 0 ? raw : "Unknown error";
  if (message.includes("429")) {
    return { status: "rate_limited", message: "Rate limited by Polymarket API. Try again shortly." };
  }
  return { status: "offline", message: "Unable to reach Polymarket APIs." };
}

export function classifyClobHealthFailure(input: {
  status?: number;
  error?: unknown;
}): { status: HealthState; reason: string } {
  if (input.status === 429) {
    return { status: "rate_limited", reason: "Rate limited by Polymarket CLOB (HTTP 429)." };
  }
  if (input.status != null) {
    return { status: "offline", reason: `CLOB health check failed (HTTP ${input.status}).` };
  }
  const err = input.error as { name?: string } | undefined;
  if (err?.name === "AbortError") {
    return { status: "offline", reason: "CLOB health check timed out." };
  }
  const raw = String(input.error ?? "");
  if (raw.includes("timed out")) {
    return { status: "offline", reason: "CLOB health check timed out." };
  }
  if (raw.includes("429")) {
    return { status: "rate_limited", reason: "Rate limited by Polymarket CLOB (HTTP 429)." };
  }
  return { status: "offline", reason: "Unable to reach Polymarket CLOB." };
}

function pickYesToken(tokens: Array<{ token_id: string; outcome: string }>) {
  return (
    tokens.find(token => String(token.outcome || "").toLowerCase() === "yes") ??
    tokens[0] ??
    null
  );
}

function pickSampleTokenIdFromMarkets(markets: GammaMarket[]) {
  for (const market of markets) {
    if (!market.active) continue;
    if (!Array.isArray(market.tokens) || market.tokens.length === 0) continue;
    const token = pickYesToken(market.tokens);
    if (token?.token_id) return token.token_id;
  }
  return null;
}

function pickSampleTokenIdFromBooks(books: JsonValue[]) {
  for (const entry of books) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, JsonValue>;
    const token = obj.token as Record<string, JsonValue> | undefined;
    if (token && token.token_id) return String(token.token_id);
  }
  return null;
}

function summarizeOrderBook(book: { bids: Array<{ price: number }>; asks: Array<{ price: number }> }) {
  const bestBid = book.bids
    .map(bid => safeNumber(bid.price, NaN))
    .filter(num => Number.isFinite(num))
    .reduce((acc, val) => (val > acc ? val : acc), Number.NEGATIVE_INFINITY);
  const bestAsk = book.asks
    .map(ask => safeNumber(ask.price, NaN))
    .filter(num => Number.isFinite(num))
    .reduce((acc, val) => (val < acc ? val : acc), Number.POSITIVE_INFINITY);

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    return { midpoint: null, spread: null };
  }
  return { midpoint: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let index = 0;
  let running = 0;

  return new Promise<R[]>((resolve, reject) => {
    const runNext = () => {
      if (index >= items.length && running === 0) {
        resolve(results);
        return;
      }
      while (running < limit && index < items.length) {
        const current = index++;
        running += 1;
        handler(items[current], current)
          .then(result => {
            results[current] = result;
          })
          .catch(reject)
          .finally(() => {
            running -= 1;
            runNext();
          });
      }
    };
    runNext();
  });
}

function uniqueMarkets(entries: JsonValue[], sinceTs = 0) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const ts = parseTimestamp(entry, 0);
    if (sinceTs > 0 && ts < sinceTs) continue;
    const obj = entry as Record<string, JsonValue>;
    const market = obj.market as Record<string, JsonValue> | undefined;
    const id = obj.market_id ?? obj.marketId ?? market?.id ?? obj.id;
    if (id) ids.add(String(id));
  }
  return ids.size;
}

function collectDataFileStats(dir: string) {
  if (!fs.existsSync(dir)) return { count: 0, totalLines: 0 };
  const files = fs.readdirSync(dir).filter(file => file.endsWith(".jsonl"));
  let totalLines = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, "utf8");
    if (!raw) continue;
    totalLines += raw
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0).length;
  }
  return { count: files.length, totalLines };
}

function extractMarketSnapshot(entry: JsonValue): MarketSnapshot | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, JsonValue>;
  const marketObj = obj.market as Record<string, JsonValue> | undefined;
  if (!marketObj) return null;
  const id = safeString(marketObj.id, safeString(obj.marketId, ""));
  if (!id) return null;
  const slug = safeString(marketObj.slug, safeString(marketObj.id, ""));
  const question = safeString(marketObj.question, safeString(marketObj.title, ""));
  const volume = marketObj.volumeNum ?? marketObj.volume ?? null;
  const bookObj = obj.book as Record<string, JsonValue> | undefined;
  let midpoint: number | null = null;
  let spread: number | null = null;

  if (bookObj && typeof bookObj === "object") {
    const bids = Array.isArray(bookObj.bids) ? (bookObj.bids as JsonValue[]) : [];
    const asks = Array.isArray(bookObj.asks) ? (bookObj.asks as JsonValue[]) : [];
    const bestBid = bids
      .map(bid => safeNumber((bid as Record<string, JsonValue>).price, NaN))
      .filter(num => Number.isFinite(num))
      .reduce((acc, val) => (val > acc ? val : acc), Number.NEGATIVE_INFINITY);
    const bestAsk = asks
      .map(ask => safeNumber((ask as Record<string, JsonValue>).price, NaN))
      .filter(num => Number.isFinite(num))
      .reduce((acc, val) => (val < acc ? val : acc), Number.POSITIVE_INFINITY);

    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
      midpoint = (bestBid + bestAsk) / 2;
      spread = bestAsk - bestBid;
    }
  }

  return {
    id,
    slug,
    question,
    volume: typeof volume === "number" && Number.isFinite(volume) ? volume : null,
    spread,
    midpoint,
    updatedAt: lastTimestamp([entry])
  };
}

function buildMarketSnapshots(entries: JsonValue[]) {
  const latest = new Map<string, { ts: number; snapshot: MarketSnapshot }>();
  for (const entry of entries) {
    const snapshot = extractMarketSnapshot(entry);
    if (!snapshot) continue;
    const ts = parseTimestamp(entry, 0);
    const existing = latest.get(snapshot.id);
    if (!existing || ts >= existing.ts) {
      latest.set(snapshot.id, { ts, snapshot: { ...snapshot, updatedAt: snapshot.updatedAt } });
    }
  }
  return Array.from(latest.values())
    .sort((a, b) => b.ts - a.ts)
    .map(item => item.snapshot);
}

function selectMarkets<T extends { active: boolean; volumeNum?: number; slug?: string; id: string }>(
  markets: T[],
  mode: string,
  limit: number,
  slugs?: string
) {
  const active = markets.filter(m => m.active);
  if (mode === "easy_targets") {
    return [...active]
      .sort((a, b) => (a.volumeNum ?? 0) - (b.volumeNum ?? 0))
      .slice(0, limit);
  }
  if (mode === "slugs") {
    const list = String(slugs ?? "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    if (list.length === 0) return [];
    return active.filter(m => list.includes(String(m.slug ?? m.id)));
  }
  return [...active]
    .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
    .slice(0, limit);
}

function extractPositions(orders: JsonValue[], marketIndex: Map<string, MarketSnapshot>) {
  const positions: PositionSnapshot[] = [];
  let counter = 0;
  for (const entry of orders) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, JsonValue>;
    const marketId = safeString(obj.marketId, safeString(obj.market_id, "unknown"));
    const marketSnapshot = marketIndex.get(marketId);
    const marketName = marketSnapshot?.slug || marketSnapshot?.question || marketId || "unknown";
    const side = safeString(obj.side, "buy_yes");
    const sizeUsd = obj.sizeUsd ?? obj.size_usd ?? obj.size;
    const entryPrice = obj.price ?? obj.entry_price;
    const markPrice = marketSnapshot?.midpoint ?? null;
    const sizeNum = sizeUsd != null ? safeNumber(sizeUsd, NaN) : NaN;
    const entryNum = entryPrice != null ? safeNumber(entryPrice, NaN) : NaN;
    let pnl: number | null = null;
    if (Number.isFinite(sizeNum) && Number.isFinite(entryNum) && typeof markPrice === "number") {
      const direction = String(side).includes("no") ? -1 : 1;
      pnl = (markPrice - entryNum) * sizeNum * direction;
    }
    positions.push({
      id: "pos-" + String(counter++),
      marketId: marketId || "unknown",
      market: marketName || "unknown",
      side,
      sizeUsd: Number.isFinite(sizeNum) ? sizeNum : null,
      entryPrice: Number.isFinite(entryNum) ? entryNum : null,
      markPrice: typeof markPrice === "number" ? markPrice : null,
      pnl,
      updatedAt: lastTimestamp([entry])
    });
  }
  return positions;
}

function extractFills(orders: JsonValue[], limit = 20) {
  const items: Array<{ id: string; time: string; market: string; side: string; price: number | null; sizeUsd: number | null; reason: string }> = [];
  let counter = 0;
  for (const entry of orders) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, JsonValue>;
    const time = lastTimestamp([entry]) || "--";
    items.push({
      id: "fill-" + String(counter++),
      time,
      market: safeString(obj.marketId, safeString(obj.market_id, "unknown")),
      side: safeString(obj.side, "buy_yes"),
      price: obj.price != null ? safeNumber(obj.price, NaN) : null,
      sizeUsd: obj.sizeUsd != null ? safeNumber(obj.sizeUsd, NaN) : null,
      reason: safeString(obj.reason, "")
    });
  }
  items.sort((a, b) => (a.time < b.time ? 1 : -1));
  return items.slice(0, limit);
}

function extractAnalyses(entries: JsonValue[], limit = 8) {
  const items: AnalysisSnapshot[] = [];
  let counter = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, JsonValue>;
    const market =
      safeString(obj.market, "") ||
      safeString(obj.marketId, "") ||
      safeString(obj.market_id, "") ||
      safeString(obj.slug, "") ||
      "unknown";
    const probability = obj.probability ?? obj.prob ?? obj.p ?? null;
    const confidence = obj.confidence ?? obj.conf ?? null;
    const rationale =
      safeString(obj.rationale, "") ||
      safeString(obj.reason, "") ||
      safeString(obj.summary, "") ||
      safeString(obj.analysis, "") ||
      "No rationale captured.";
    const usage = obj.usage as Record<string, JsonValue> | undefined;
    const tokens =
      obj.tokens ??
      obj.total_tokens ??
      obj.token_count ??
      (usage ? usage.total_tokens ?? usage.totalTokens : null) ??
      null;
    const cost = obj.cost ?? obj.usd ?? obj.total ?? obj.amount ?? null;
    items.push({
      id: "analysis-" + String(counter++),
      market,
      probability: probability != null ? safeNumber(probability, NaN) : null,
      confidence: confidence != null ? safeNumber(confidence, NaN) : null,
      rationale: rationale.length > 140 ? rationale.slice(0, 137) + "..." : rationale,
      tokens: tokens != null ? safeNumber(tokens, NaN) : null,
      cost: cost != null ? safeNumber(cost, NaN) : null,
      updatedAt: lastTimestamp([entry])
    });
  }
  items.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
  return items.slice(0, limit);
}

function classifyActivity(file: string, entry: JsonValue): ActivityItem {
  const fileHint = file.toLowerCase();
  const typeRaw = entry && typeof entry === "object" ? (entry as Record<string, JsonValue>).type : undefined;
  const messageRaw = entry && typeof entry === "object" ? (entry as Record<string, JsonValue>).message : undefined;
  const event = safeString(typeRaw, "").toLowerCase();
  let type: ActivityItem["type"] = "Info";
  if (fileHint.includes("analysis") || event.includes("analysis")) type = "Analysis";
  else if (fileHint.includes("cost") || event.includes("cost")) type = "Cost";
  else if (fileHint.includes("order") || fileHint.includes("execution") || event.includes("trade") || event.includes("order")) type = "Trade";
  else if (event.includes("warn") || event.includes("error") || event.includes("fail")) type = "Error";

  const ts = parseTimestamp(entry, 0);
  const description =
    safeString(messageRaw, "") ||
    safeString((entry && typeof entry === "object" && (entry as Record<string, JsonValue>).summary) || "", "") ||
    safeString((entry && typeof entry === "object" && (entry as Record<string, JsonValue>).market) || "", "") ||
    "Activity recorded";

  let value: string | undefined;
  if (entry && typeof entry === "object") {
    const obj = entry as Record<string, JsonValue>;
    if (obj.pnl !== undefined) value = formatCurrency(safeNumber(obj.pnl, 0));
    else if (obj.profit !== undefined) value = formatCurrency(safeNumber(obj.profit, 0));
    else if (obj.cost !== undefined) value = formatCurrency(safeNumber(obj.cost, 0));
    else if (obj.amount !== undefined) value = formatCurrency(safeNumber(obj.amount, 0));
  }

  return {
    id: file + "-" + String(ts) + "-" + Math.random().toString(36).slice(2, 8),
    time: ts > 0 ? new Date(ts).toLocaleTimeString() : "--",
    type,
    description,
    value,
    source: file,
    ts
  };
}

function buildActivityFeed(dir: string, limit = 30) {
  const sources = readAllJsonl(dir);
  const items: ActivityItem[] = [];
  for (const source of sources) {
    for (const entry of source.entries) {
      items.push(classifyActivity(source.file, entry));
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, limit);
}

function appendEvent(kind: string, message: string, detail?: Record<string, JsonValue>) {
  try {
    const payload = {
      t: new Date().toISOString(),
      type: kind,
      message,
      ...detail
    };
    const p = path.join(DATA_DIR, FILES.events);
    fs.appendFileSync(p, JSON.stringify(payload) + "\n", "utf8");
  } catch {
    // Ignore event logging failures.
  }
}

function getCachedClobSummary(tokenId: string) {
  const cached = clobSummaryCache.get(tokenId);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CLOB_SUMMARY_TTL_MS) return null;
  return cached;
}

async function fetchClobSummary(runtime: Runtime, tokenId: string) {
  const cached = getCachedClobSummary(tokenId);
  if (cached) return cached;
  const book = await runtime.clob.getOrderBook(tokenId);
  const summary = summarizeOrderBook(book);
  const spreadBps = summary.spread != null ? summary.spread * 10000 : null;
  const payload = {
    fetchedAt: Date.now(),
    midpoint: summary.midpoint,
    spread: summary.spread,
    spreadBps
  };
  clobSummaryCache.set(tokenId, payload);
  return payload;
}

function getMarketUpdatedAt(market: GammaMarket, fallbackIso: string) {
  const rawUpdatedAt =
    (market as Record<string, unknown>).updatedAt ??
    (market as Record<string, unknown>).updated_at ??
    (market as Record<string, unknown>).lastUpdated ??
    null;
  if (!rawUpdatedAt) return fallbackIso;
  const parsed = Date.parse(String(rawUpdatedAt));
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return fallbackIso;
}

async function getGammaMarketsCached(runtime: Runtime, flags: MarketFilterFlags) {
  const key = `active=${flags.activeOnly ? "1" : "0"}|resolved=${flags.includeResolved ? "1" : "0"}`;
  const now = Date.now();
  const cachedEntry = gammaMarketsCache.get(key);
  if (cachedEntry && now - cachedEntry.fetchedAt < GAMMA_MARKETS_TTL_MS) {
    return { items: cachedEntry.items, cached: true, ageMs: now - cachedEntry.fetchedAt };
  }
  const inFlight = gammaMarketsInFlight.get(key);
  if (inFlight) {
    const items = await inFlight;
    const fresh = gammaMarketsCache.get(key);
    const ageMs = fresh ? now - fresh.fetchedAt : 0;
    return { items, cached: true, ageMs };
  }
  const request = runtime.gamma.listMarkets(GAMMA_MARKETS_LIMIT, {
    activeOnly: flags.activeOnly,
    includeResolved: flags.includeResolved
  });
  gammaMarketsInFlight.set(key, request);
  try {
    const items = await request;
    gammaMarketsCache.set(key, { fetchedAt: Date.now(), items });
    return { items, cached: false, ageMs: 0 };
  } finally {
    gammaMarketsInFlight.delete(key);
  }
}

function normalizeSort(sortRaw: string, selector: string): LiveMarketsSort {
  if (sortRaw === "spread_asc" || sortRaw === "updated_desc" || sortRaw === "volume_desc") {
    return sortRaw;
  }
  if (selector === "easy_targets") return "volume_asc";
  return "volume_desc";
}

export function filterGammaMarkets(markets: GammaMarket[], input: MarketFilterInput) {
  const query = input.query.trim().toLowerCase();
  const nowMs = input.nowMs;
  return markets.filter(market => {
    if (input.activeOnly && !market.active) return false;
    if (!input.includeResolved && isMarketResolved(market)) return false;
    const endDateMs = getMarketEndDateMs(market);
    if (endDateMs != null && endDateMs < nowMs) return false;
    if (input.selector === "slugs" && input.slugList.length > 0) {
      const slug = String(market.slug ?? market.id);
      if (!input.slugList.includes(slug)) return false;
    }
    if (query) {
      const haystack = (String(market.slug || "") + " " + String(market.question || "")).toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (input.minVolume != null && (market.volumeNum ?? 0) < input.minVolume) return false;
    if (input.minLiquidityUsd != null && (market.liquidityNum ?? 0) < input.minLiquidityUsd) return false;
    if (input.maxSpreadBps != null) {
      const token = pickYesToken(market.tokens);
      if (token) {
        const cachedSummary = getCachedClobSummary(token.token_id);
        if (cachedSummary && cachedSummary.spreadBps != null && cachedSummary.spreadBps > input.maxSpreadBps) {
          return false;
        }
      }
    }
    return true;
  });
}

type SortableMarketRow = {
  market: GammaMarket;
  spreadBps: number | null;
  updatedAt: string;
};

export function compareLiveMarketRows(a: SortableMarketRow, b: SortableMarketRow, sort: LiveMarketsSort) {
  if (sort === "spread_asc") {
    const aSpread = a.spreadBps == null ? Number.POSITIVE_INFINITY : a.spreadBps;
    const bSpread = b.spreadBps == null ? Number.POSITIVE_INFINITY : b.spreadBps;
    if (aSpread !== bSpread) return aSpread - bSpread;
    const volumeDelta = (b.market.volumeNum ?? 0) - (a.market.volumeNum ?? 0);
    if (volumeDelta !== 0) return volumeDelta;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }
  if (sort === "updated_desc") {
    const updatedDelta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return (b.market.volumeNum ?? 0) - (a.market.volumeNum ?? 0);
  }
  if (sort === "volume_asc") {
    const volumeDelta = (a.market.volumeNum ?? 0) - (b.market.volumeNum ?? 0);
    if (volumeDelta !== 0) return volumeDelta;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }
  const volumeDelta = (b.market.volumeNum ?? 0) - (a.market.volumeNum ?? 0);
  if (volumeDelta !== 0) return volumeDelta;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

async function fetchLiveMarkets(
  runtime: Runtime,
  opts: {
    limit: number;
    offset: number;
    selector: string;
    sort: string;
    minVolume: number | null;
    maxSpreadBps: number | null;
    minLiquidityUsd: number | null;
    q: string;
    activeOnly: boolean;
    includeResolved: boolean;
  }
): Promise<LiveMarketsResponse> {
  const nowIso = new Date().toISOString();
  let markets: GammaMarket[];
  let cached = false;
  let ageMs = 0;

  try {
    const gamma = await getGammaMarketsCached(runtime, {
      activeOnly: opts.activeOnly,
      includeResolved: opts.includeResolved
    });
    markets = gamma.items;
    cached = gamma.cached;
    ageMs = gamma.ageMs;
  } catch (err) {
    const classification = classifyApiError(err);
    return {
      totalCount: 0,
      items: [],
      status: classification.status,
      updatedAt: nowIso,
      error: classification.message
    };
  }

  const selectorRaw = opts.selector;
  const selector =
    selectorRaw === "easy_targets" || selectorRaw === "top_volume" || selectorRaw === "slugs"
      ? selectorRaw
      : "top_volume";
  const sort = normalizeSort(opts.sort, selector);
  const minVolume = opts.minVolume != null && opts.minVolume > 0 ? opts.minVolume : null;
  const minLiquidityUsd = opts.minLiquidityUsd != null && opts.minLiquidityUsd > 0 ? opts.minLiquidityUsd : null;
  const maxSpreadBps = opts.maxSpreadBps != null && opts.maxSpreadBps > 0 ? opts.maxSpreadBps : null;
  const query = opts.q.trim().toLowerCase();
  const nowMs = Date.now();

  const slugList =
    selector === "slugs"
      ? String(runtime.env.TARGET_SLUGS || "")
          .split(",")
          .map(value => value.trim())
          .filter(Boolean)
      : [];

  const filtered = filterGammaMarkets(markets, {
    activeOnly: opts.activeOnly,
    includeResolved: opts.includeResolved,
    nowMs,
    minVolume,
    maxSpreadBps,
    minLiquidityUsd,
    query,
    selector,
    slugList
  });

  const sortable: SortableMarketRow[] = filtered.map(market => {
    const token = pickYesToken(market.tokens);
    const cachedSummary = token ? getCachedClobSummary(token.token_id) : null;
    const spreadBps = cachedSummary ? cachedSummary.spreadBps : null;
    return {
      market,
      spreadBps,
      updatedAt: getMarketUpdatedAt(market, nowIso)
    };
  });

  sortable.sort((a, b) => compareLiveMarketRows(a, b, sort));

  const totalCount = sortable.length;
  if (totalCount === 0) {
    return {
      totalCount,
      items: [],
      status: "empty",
      updatedAt: nowIso,
      cached,
      ageMs
    };
  }

  const start = clampNumber(Math.floor(opts.offset), 0, Math.max(0, totalCount));
  const end = clampNumber(start + opts.limit, 0, totalCount);
  const page = sortable.slice(start, end);

  let clobErrors = 0;
  let clobSuccess = 0;
  let clobRateLimited = false;

  const items = await mapWithConcurrency(page, 4, async row => {
    const market = row.market;
    const token = pickYesToken(market.tokens);
    const cachedSummary = token ? getCachedClobSummary(token.token_id) : null;
    let midpoint: number | null = cachedSummary ? cachedSummary.midpoint : null;
    let spread: number | null = cachedSummary ? cachedSummary.spread : null;
    let spreadBps: number | null = cachedSummary ? cachedSummary.spreadBps : null;

    if (token && spreadBps == null) {
      try {
        const summary = await fetchClobSummary(runtime, token.token_id);
        midpoint = summary.midpoint;
        spread = summary.spread;
        spreadBps = summary.spreadBps;
        clobSuccess += 1;
      } catch (err) {
        clobErrors += 1;
        const classification = classifyApiError(err);
        if (classification.status === "rate_limited") clobRateLimited = true;
      }
    }

    return {
      id: market.id,
      slug: safeString(market.slug, market.id),
      title: safeString(market.question, safeString(market.slug, market.id)),
      volume: market.volumeNum ?? null,
      liquidityUsd: market.liquidityNum ?? null,
      spread,
      spreadBps,
      midpoint,
      updatedAt: row.updatedAt
    };
  });

  let status: LiveMarketsStatus = "ok";
  let error: string | undefined;
  if (clobSuccess === 0 && clobErrors > 0) {
    status = clobRateLimited ? "rate_limited" : "offline";
    error = clobRateLimited
      ? "Rate limited by Polymarket CLOB. Try again shortly."
      : "Unable to reach Polymarket CLOB.";
  } else if (clobRateLimited) {
    status = "rate_limited";
    error = "Rate limited by Polymarket CLOB. Showing partial order books.";
  } else if (clobErrors > 0) {
    status = "partial";
    error = "Some order books failed to load. Showing partial data.";
  }

  return {
    totalCount,
    items,
    status,
    updatedAt: nowIso,
    error,
    cached,
    ageMs
  };
}

async function getLiveMarketsCached(
  runtime: Runtime,
  opts: {
    limit: number;
    offset: number;
    selector: string;
    sort: string;
    minVolume: number | null;
    maxSpreadBps: number | null;
    minLiquidityUsd: number | null;
    q: string;
    activeOnly: boolean;
    includeResolved: boolean;
  }
) {
  const limit = clampNumber(Math.floor(opts.limit), 1, 100);
  const offset = clampNumber(Math.floor(opts.offset), 0, Number.MAX_SAFE_INTEGER);
  return fetchLiveMarkets(runtime, { ...opts, limit, offset });
}

function clearJsonlFiles(dir: string) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const full = path.join(dir, file);
    if (!fs.statSync(full).isFile()) continue;
    fs.rmSync(full);
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", err => reject(err));
  });
}

function respondJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function checkGamma(runtime: Runtime, now: number) {
  const cache = healthCache.gamma;
  if (now - cache.checkedAt < 60000) return cache.status;
  cache.checkedAt = now;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const url = new URL("/markets", runtime.env.POLYMARKET_GAMMA_BASE_URL);
    url.searchParams.set("limit", "1");
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    cache.status = res.ok ? "connected" : "offline";
  } catch {
    cache.status = "offline";
  }
  return cache.status;
}

async function checkClob(runtime: Runtime, now: number, sampleTokenId: string | null) {
  const cache = healthCache.clob;
  if (now - cache.checkedAt < CLOB_HEALTH_TTL_MS) {
    return { status: cache.status, reason: cache.reason };
  }
  cache.checkedAt = now;
  if (!sampleTokenId) {
    cache.status = "unknown";
    cache.reason = "No token id available for CLOB health check.";
    return { status: cache.status, reason: cache.reason };
  }

  const deadline = Date.now() + CLOB_HEALTH_TIMEOUT_MS;

  const probe = async (path: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("CLOB health check timed out.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const url = new URL(path, runtime.env.POLYMARKET_CLOB_BASE_URL);
      url.searchParams.set("token_id", sampleTokenId);
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) return { status: "connected" as HealthState, reason: null as string | null };
      if (res.status === 429) {
        return {
          status: "rate_limited" as HealthState,
          reason: "Rate limited by Polymarket CLOB.",
          statusCode: 429
        };
      }
      const classification = classifyClobHealthFailure({ status: res.status });
      return { status: classification.status, reason: classification.reason, statusCode: res.status };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const primary = await probe("/midpoint");
    if (primary.status === "connected" || primary.status === "rate_limited") {
      cache.status = primary.status;
      cache.reason = primary.reason ?? null;
      return { status: cache.status, reason: cache.reason };
    }
    if (primary.status === "offline" && primary.statusCode != null) {
      const statusCode = primary.statusCode;
      if (statusCode === 404 || statusCode === 405) {
        const fallback = await probe("/book");
        cache.status = fallback.status;
        cache.reason = fallback.reason ?? null;
        return { status: cache.status, reason: cache.reason };
      }
    }
    cache.status = primary.status;
    cache.reason = primary.reason ?? null;
  } catch (err) {
    const classification = classifyClobHealthFailure({ error: err });
    cache.status = classification.status;
    cache.reason = classification.reason;
  }
  return { status: cache.status, reason: cache.reason };
}

async function checkOpenAI(runtime: Runtime, now: number) {
  const cache = healthCache.openai;
  if (!runtime.env.OPENAI_API_KEY) {
    cache.status = "offline";
    return cache.status;
  }
  if (now - cache.checkedAt < 300000) return cache.status;
  cache.checkedAt = now;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://api.openai.com/v1/models", {
      signal: controller.signal,
      headers: { Authorization: "Bearer " + runtime.env.OPENAI_API_KEY }
    });
    clearTimeout(timer);
    cache.status = res.ok ? "connected" : "offline";
  } catch {
    cache.status = "offline";
  }
  return cache.status;
}

async function summarize(runtime: Runtime): Promise<Summary> {
  const books = readJsonl(path.join(DATA_DIR, FILES.books)).entries;
  const orders = readJsonl(path.join(DATA_DIR, FILES.orders)).entries;
  const executions = readJsonl(path.join(DATA_DIR, FILES.executions)).entries;
  const paper = readJsonl(path.join(DATA_DIR, FILES.paper)).entries;
  const analyses = readJsonl(path.join(DATA_DIR, FILES.analyses)).entries;
  const costs = readJsonl(path.join(DATA_DIR, FILES.costs)).entries;
  const llmCosts = readJsonl(path.join(DATA_DIR, FILES.llmCosts)).entries;
  const selector = readJsonl(path.join(DATA_DIR, FILES.selector)).entries;

  const todayStart = startOfToday();
  const hourStart = startOfHour();

  const marketsAnalyzedToday = uniqueMarkets(books, todayStart);
  const openPositions = orders.length;
  const totalPnl =
    sumBy(executions, ["pnl", "profit", "realizedPnl", "realized_pnl"]) +
    sumBy(paper, ["pnl", "profit", "realizedPnl", "realized_pnl"]);

  const llmCostEntries = [...costs, ...llmCosts, ...analyses];
  const costToday = llmCostEntries.reduce<number>((acc, entry) => {
    const ts = parseTimestamp(entry, 0);
    if (ts >= todayStart) {
      return acc + sumBy([entry], ["cost", "usd", "total", "amount"]);
    }
    return acc;
  }, 0);
  const costHour = llmCostEntries.reduce<number>((acc, entry) => {
    const ts = parseTimestamp(entry, 0);
    if (ts >= hourStart) {
      return acc + sumBy([entry], ["cost", "usd", "total", "amount"]);
    }
    return acc;
  }, 0);

  const bankrollUsd = runtime.env.BANKROLL_USD;
  const uiSettings = getUiSettings(runtime);
  const kellyCapUsd = bankrollUsd * uiSettings.kellyFraction;
  const effectiveMaxPosUsd = Math.min(uiSettings.maxPosUsd, kellyCapUsd);
  const maxPositionUsd = effectiveMaxPosUsd;
  const riskPercent = bankrollUsd > 0 ? (maxPositionUsd / bankrollUsd) * 100 : 0;
  const maxDailyLossPct = bankrollUsd > 0 ? (uiSettings.maxDailyLossUsd / bankrollUsd) * 100 : 0;

  const tightKelly = uiSettings.kellyFraction <= 0.1;
  const tightMaxPos =
    effectiveMaxPosUsd <= 2 || (bankrollUsd > 0 && effectiveMaxPosUsd / bankrollUsd <= 0.01);
  const tightDailyLoss =
    uiSettings.maxDailyLossUsd <= 5 ||
    (bankrollUsd > 0 && uiSettings.maxDailyLossUsd / bankrollUsd <= 0.02);
  const tightMaxPositions = uiSettings.maxPositions <= 1;
  const tightSpread = uiSettings.spreadBps <= 5;
  const tightDepth = uiSettings.minDepthUsd >= Math.max(200, bankrollUsd * 0.5);

  const budgetDay = runtime.env.MAX_LLM_USD_PER_DAY;
  const budgetHour = runtime.env.MAX_LLM_USD_PER_HOUR;
  const remainingDay = budgetDay - costToday;
  const remainingHour = budgetHour - costHour;

  const lastRunTime = lastTimestamp([...books, ...orders, ...executions, ...paper]);
  if (lastRunTime) state.lastRunTime = lastRunTime;
  const lastSelectionTime = lastTimestamp(selector);

  const dataFiles = collectDataFileStats(DATA_DIR);
  const memoryMb = process.memoryUsage().rss / 1024 / 1024;
  const uptimeSec = process.uptime();

  const sampleTokenId = await (async () => {
    const fromBooks = pickSampleTokenIdFromBooks(books);
    try {
      const gamma = await getGammaMarketsCached(runtime, { activeOnly: true, includeResolved: false });
      const fromMarkets = pickSampleTokenIdFromMarkets(gamma.items);
      return fromMarkets ?? fromBooks;
    } catch {
      return fromBooks;
    }
  })();

  const now = Date.now();
  const gamma = await checkGamma(runtime, now);
  const clob = await checkClob(runtime, now, sampleTokenId);
  const openai = await checkOpenAI(runtime, now);

  return {
    status: {
      running: state.running,
      mode: state.mode,
      paperOnly: PAPER_ONLY,
      selector: state.selector,
      intervalMs: state.intervalMs,
      lastRunTime: state.lastRunTime
    },
    stats: {
      marketsAnalyzedToday,
      openPositions,
      totalPnl
    },
    llm: {
      costToday,
      costHour,
      budgetDay,
      budgetHour,
      remainingDay,
      remainingHour
    },
    strategy: {
      bankrollUsd,
      maxPositionUsd,
      riskPercent,
      fractionalKelly: uiSettings.kellyFraction,
      spreadFilter: uiSettings.spreadBps > 0 ? `≤ ${uiSettings.spreadBps.toFixed(1)} bps` : "No spread filter configured",
      depthFilter: uiSettings.minDepthUsd > 0 ? `≥ ${formatCurrency(uiSettings.minDepthUsd)}` : "No depth filter configured"
    },
    risk: {
      settings: {
        kellyFraction: uiSettings.kellyFraction,
        maxPosUsd: uiSettings.maxPosUsd,
        maxDailyLossUsd: uiSettings.maxDailyLossUsd,
        maxPositions: uiSettings.maxPositions,
        spreadBps: uiSettings.spreadBps,
        minDepthUsd: uiSettings.minDepthUsd
      },
      effective: {
        kellyCapUsd,
        maxPosUsd: effectiveMaxPosUsd,
        maxPosPct: bankrollUsd > 0 ? (effectiveMaxPosUsd / bankrollUsd) * 100 : 0,
        maxDailyLossUsd: uiSettings.maxDailyLossUsd,
        maxDailyLossPct,
        maxPositions: uiSettings.maxPositions,
        spreadBps: uiSettings.spreadBps,
        minDepthUsd: uiSettings.minDepthUsd
      },
      tight: {
        kellyFraction: tightKelly,
        maxPosUsd: tightMaxPos,
        maxDailyLossUsd: tightDailyLoss,
        maxPositions: tightMaxPositions,
        spreadBps: tightSpread,
        minDepthUsd: tightDepth
      }
    },
    selection: {
      mode: runtime.env.TARGETS_MODE,
      lastSelectionTime
    },
    health: {
      gamma,
      clob: clob.status,
      clobDetail: clob.reason ?? null,
      openai,
      uptimeSec,
      memoryMb,
      dataFiles
    }
  };
}

function renderDashboard(port: number) {
  return `<!doctype html>
<html class="h-full" lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#0b1020" />
    <title>Polymarket Rick's Bot Control Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: {
              display: ["Space Grotesk", "ui-sans-serif", "system-ui"],
              body: ["IBM Plex Sans", "ui-sans-serif", "system-ui"]
            },
            boxShadow: {
              glow: "0 0 60px rgba(59, 130, 246, 0.2)"
            }
          }
        }
      };
    </script>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
    <style>
      ::-webkit-scrollbar { width: 10px; }
      ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 999px; }
      ::-webkit-scrollbar-track { background: #0b1020; }
      .grid-card { background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(148, 163, 184, 0.2); }
      .chip { border: 1px solid rgba(148, 163, 184, 0.4); }
      .soft-ring { box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.2); }
      .pulse-dot { box-shadow: 0 0 16px rgba(16, 185, 129, 0.7); animation: pulse 2s infinite; }
      @keyframes pulse { 0% { transform: scale(0.95); opacity: 0.7; } 70% { transform: scale(1.05); opacity: 1; } 100% { transform: scale(0.95); opacity: 0.7; } }
      .fade-in { animation: fade 0.6s ease-out; }
      @keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body class="min-h-full bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-100 font-body" data-refresh-ms="10000" data-refresh-min="5000" data-refresh-max="15000">
    <div class="absolute inset-0 pointer-events-none">
      <div class="absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl"></div>
      <div class="absolute top-1/3 right-0 h-80 w-80 translate-x-1/3 rounded-full bg-emerald-500/10 blur-3xl"></div>
      <div class="absolute bottom-0 left-0 h-72 w-72 -translate-x-1/3 rounded-full bg-cyan-400/10 blur-3xl"></div>
    </div>
    <main class="relative mx-auto flex max-w-7xl flex-col gap-8 px-6 py-10 lg:px-10">
      <section class="grid-card rounded-3xl p-8 shadow-glow">
        <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p class="text-xs uppercase tracking-[0.4em] text-slate-400">Trading + Ops Control</p>
            <h1 class="mt-3 text-3xl font-display font-semibold text-white lg:text-4xl">Polymarket Rick's Bot</h1>
            <p class="mt-3 max-w-2xl text-sm text-slate-300">Unified trading, market intel, and ops telemetry. Switch modes, inspect selections, and trigger new analyses from one command hub.</p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <span class="chip inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-emerald-200">
              <span id="statusDot" class="h-2.5 w-2.5 rounded-full bg-emerald-400 pulse-dot"></span>
              <span id="statusText">RUNNING</span>
            </span>
            <span class="chip inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-cyan-200">
              Mode: <span id="modeBadge">paper</span>
            </span>
            <span class="chip inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-slate-200">
              Selector: <span id="selectorBadge">top_volume</span>
            </span>
          </div>
        </div>
        <div class="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
            <p class="text-xs uppercase tracking-widest text-slate-400">Markets Analyzed Today</p>
            <p id="marketsAnalyzed" class="mt-2 text-2xl font-semibold text-white">0</p>
            <p id="lastRun" class="mt-2 text-xs text-slate-400">Last run: --</p>
          </div>
          <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
            <p class="text-xs uppercase tracking-widest text-slate-400">Open Positions</p>
            <p id="openPositions" class="mt-2 text-2xl font-semibold text-white">0</p>
            <p class="mt-2 text-xs text-slate-400">Paper ledger</p>
          </div>
          <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
            <p class="text-xs uppercase tracking-widest text-slate-400">Total PnL</p>
            <p id="totalPnl" class="mt-2 text-2xl font-semibold text-emerald-300">$0.00</p>
            <p class="mt-2 text-xs text-slate-400">Net across fills</p>
          </div>
          <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
            <p class="text-xs uppercase tracking-widest text-slate-400">LLM Burn</p>
            <p id="llmCost" class="mt-2 text-2xl font-semibold text-white">$0.00</p>
            <p id="llmCostHour" class="mt-2 text-xs text-slate-400">Hour: $0.00</p>
            <p id="llmRemaining" class="mt-2 text-xs text-slate-400">Remaining: $0.00 day / $0.00 hr</p>
          </div>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-[1.2fr,1.8fr]">
        <div class="grid gap-6">
          <div class="grid-card rounded-2xl p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-emerald-200">Strategy</p>
                <h2 class="mt-2 text-lg font-semibold">Kelly Sizing</h2>
              </div>
              <span class="chip rounded-full px-3 py-1 text-xs text-emerald-200">Risk Guardrails</span>
            </div>
            <div class="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p class="text-xs text-slate-400">Bankroll</p>
                <p id="bankroll" class="text-sm font-semibold">$0.00</p>
              </div>
              <div>
                <p class="text-xs text-slate-400">Max position</p>
                <p id="maxPosition" class="text-sm font-semibold">$0.00</p>
              </div>
              <div>
                <p class="text-xs text-slate-400">Risk %</p>
                <p id="riskPercent" class="text-sm font-semibold">0%</p>
              </div>
              <div>
                <p class="text-xs text-slate-400">Fractional Kelly</p>
                <p id="fractionalKelly" class="text-sm font-semibold">0.00</p>
              </div>
            </div>
            <div class="mt-5 text-xs text-slate-400">
              <p id="spreadFilter">Spread filter: --</p>
              <p id="depthFilter" class="mt-1">Depth filter: --</p>
            </div>
          </div>

          <div class="grid-card rounded-2xl p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-rose-200">Risk Controls</p>
                <h2 class="mt-2 text-lg font-semibold">Adjust Guardrails</h2>
              </div>
              <span class="chip rounded-full px-3 py-1 text-xs text-rose-200">Paper-only</span>
            </div>
            <div class="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-300">
              <div class="flex items-center justify-between">
                <span>Effective max position</span>
                <span id="riskEffectiveMaxPos" class="text-slate-100">$0.00</span>
              </div>
              <div id="riskKellyCap" class="mt-2 text-slate-400">Kelly cap: --</div>
              <div id="riskDailyLossCap" class="mt-1 text-slate-400">Daily loss cap: --</div>
              <div id="riskMaxPositionsCap" class="mt-1 text-slate-400">Max positions: --</div>
            </div>
            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-xs text-slate-400">Kelly fraction</label>
                  <span id="kellyWarning" class="hidden rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Tight</span>
                </div>
                <input id="kellyFractionRange" class="mt-2 w-full accent-emerald-400" type="range" min="0" max="1" step="0.01" />
                <input id="kellyFractionInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" max="1" step="0.01" />
              </div>
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-xs text-slate-400">Max position (USD)</label>
                  <span id="maxPosWarning" class="hidden rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Tight</span>
                </div>
                <input id="maxPosUsdInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" step="0.01" />
                <input id="maxPosPctInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" step="0.1" />
                <p class="mt-1 text-[10px] text-slate-500">% bankroll</p>
              </div>
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-xs text-slate-400">Max daily loss (USD)</label>
                  <span id="dailyLossWarning" class="hidden rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Tight</span>
                </div>
                <input id="maxDailyLossUsdInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" step="0.01" />
                <p id="dailyLossPctLabel" class="mt-1 text-[10px] text-slate-500">--% bankroll</p>
              </div>
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-xs text-slate-400">Max concurrent positions</label>
                  <span id="positionsWarning" class="hidden rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Tight</span>
                </div>
                <input id="maxPositionsInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" step="1" />
              </div>
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-xs text-slate-400">Spread threshold (bps)</label>
                  <span id="spreadWarning" class="hidden rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Tight</span>
                </div>
                <input id="spreadBpsInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" step="0.1" />
              </div>
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-xs text-slate-400">Min depth (USD)</label>
                  <span id="depthWarning" class="hidden rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Tight</span>
                </div>
                <input id="minDepthUsdInput" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" step="1" />
              </div>
            </div>
            <div class="mt-4 flex flex-wrap items-center gap-3">
              <button id="saveRisk" class="rounded-full bg-rose-400 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-rose-300" type="button">Save risk settings</button>
              <span id="riskSaveStatus" class="text-xs text-slate-400">Not saved yet.</span>
            </div>
          </div>

          <div class="grid-card rounded-2xl p-6">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-cyan-200">LLM / Analyst</p>
                <h2 class="mt-2 text-lg font-semibold">Latest Analyses</h2>
              </div>
              <button id="runAnalysis" class="rounded-full bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400" type="button">Analyze selected market now</button>
            </div>
            <div class="mt-4 flex items-center gap-3">
              <label class="text-xs text-slate-400">Market</label>
              <select id="analysisMarket" class="flex-1 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
                <option value="">No markets yet</option>
              </select>
            </div>
            <div id="analysisList" class="mt-5 space-y-3">
              <div class="text-sm text-slate-400">No analyses yet.</div>
            </div>
          </div>
        </div>

        <div class="grid-card rounded-2xl p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-blue-200">Markets</p>
              <h2 class="mt-2 text-lg font-semibold">Selected Markets</h2>
            </div>
            <button id="refreshMarkets" class="rounded-full border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400" type="button">Refresh market list</button>
          </div>
          <div class="mt-3 flex items-center justify-between text-xs text-slate-400">
            <span id="marketsStatus">Loading live markets...</span>
            <span id="marketsMeta"></span>
          </div>
          <div class="mt-4 overflow-x-auto">
            <table class="min-w-full text-left text-xs">
              <thead class="text-slate-400">
                <tr>
                  <th class="pb-2">Slug</th>
                  <th class="pb-2">Title</th>
                  <th class="pb-2">Volume</th>
                  <th class="pb-2">Spread</th>
                  <th class="pb-2">Midpoint</th>
                  <th class="pb-2">Updated at</th>
                </tr>
              </thead>
              <tbody id="marketsTable" class="text-slate-200"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-[1.6fr,1fr]">
        <div class="grid-card rounded-2xl p-6">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-emerald-200">Performance</p>
              <h2 class="mt-2 text-lg font-semibold">PnL Over Time</h2>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <button class="pnl-range-btn rounded-full border border-slate-700 px-3 py-1 text-slate-300 transition hover:border-emerald-300" data-range="24h" type="button">24h</button>
              <button class="pnl-range-btn rounded-full border border-emerald-400/60 bg-emerald-400/10 px-3 py-1 text-emerald-100" data-range="7d" type="button">7d</button>
              <button class="pnl-range-btn rounded-full border border-slate-700 px-3 py-1 text-slate-300 transition hover:border-emerald-300" data-range="30d" type="button">30d</button>
            </div>
          </div>
          <div class="mt-5 grid gap-4 sm:grid-cols-3">
            <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
              <p class="text-xs uppercase tracking-widest text-slate-400">Current PnL</p>
              <p id="pnlCurrent" class="mt-2 text-xl font-semibold text-emerald-300">$0.00</p>
              <p id="pnlRangeLabel" class="mt-2 text-xs text-slate-400">Range: 7d</p>
            </div>
            <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
              <p class="text-xs uppercase tracking-widest text-slate-400">Daily Change</p>
              <p id="pnlDaily" class="mt-2 text-xl font-semibold text-slate-100">$0.00</p>
              <p id="pnlDailyNote" class="mt-2 text-xs text-slate-400">vs. 24h ago</p>
            </div>
            <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring">
              <p class="text-xs uppercase tracking-widest text-slate-400">Peak-to-trough</p>
              <p id="pnlDrawdown" class="mt-2 text-xl font-semibold text-slate-100">$0.00</p>
              <p class="mt-2 text-xs text-slate-400">Max drawdown</p>
            </div>
          </div>
          <div class="mt-6">
            <div id="pnlEmpty" class="rounded-2xl border border-dashed border-slate-800 bg-slate-950/60 px-4 py-8 text-center text-sm text-slate-400">
              No PnL data yet. Run the bot to generate paper executions.
            </div>
            <div class="relative hidden h-56 w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60 sm:h-64" id="pnlChartWrap">
              <svg id="pnlChart" viewBox="0 0 640 240" class="h-full w-full"></svg>
            </div>
          </div>
        </div>

        <div class="grid-card rounded-2xl p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-slate-300">PnL Details</p>
              <h2 class="mt-2 text-lg font-semibold">Series Stats</h2>
            </div>
            <span id="pnlUpdated" class="text-xs text-slate-400">Updated --</span>
          </div>
          <div class="mt-4 space-y-3 text-sm">
            <div class="flex items-center justify-between">
              <span>Points</span>
              <span id="pnlPoints" class="text-slate-200">0</span>
            </div>
            <div class="flex items-center justify-between">
              <span>High</span>
              <span id="pnlHigh" class="text-slate-200">$0.00</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Low</span>
              <span id="pnlLow" class="text-slate-200">$0.00</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span>Range start</span>
              <span id="pnlRangeStart">--</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span>Range end</span>
              <span id="pnlRangeEnd">--</span>
            </div>
          </div>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-[1.4fr,1fr]">
        <div class="grid-card rounded-2xl p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-amber-200">Positions & Orders</p>
              <h2 class="mt-2 text-lg font-semibold">Open Positions</h2>
            </div>
            <button id="closeAll" class="rounded-full border border-amber-400/50 px-4 py-2 text-xs font-semibold text-amber-200 transition hover:border-amber-300" type="button">Close all positions</button>
          </div>
          <div class="mt-4 overflow-x-auto">
            <table class="min-w-full text-left text-xs">
              <thead class="text-slate-400">
                <tr>
                  <th class="pb-2">Market</th>
                  <th class="pb-2">Size</th>
                  <th class="pb-2">Entry</th>
                  <th class="pb-2">Mark</th>
                  <th class="pb-2">PnL</th>
                </tr>
              </thead>
              <tbody id="positionsTable" class="text-slate-200"></tbody>
            </table>
          </div>
          <div class="mt-6">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold">Paper fills / executions</h3>
              <span class="text-xs text-slate-400">Latest 12</span>
            </div>
            <div id="fillsFeed" class="mt-3 space-y-2"></div>
          </div>
        </div>

        <div class="grid-card rounded-2xl p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-slate-300">System Health</p>
              <h2 class="mt-2 text-lg font-semibold">Connectivity</h2>
            </div>
            <span id="refreshLabel" class="text-xs text-slate-400">Auto-refresh 10s</span>
          </div>
          <div class="mt-4 space-y-3 text-sm">
            <div class="flex items-center justify-between">
              <span>CLOB</span>
              <span id="clobStatus" class="chip rounded-full px-3 py-1 text-xs">Unknown</span>
            </div>
            <div id="clobDetail" class="text-xs text-slate-400 hidden">--</div>
            <div class="flex items-center justify-between">
              <span>Gamma</span>
              <span id="gammaStatus" class="chip rounded-full px-3 py-1 text-xs">Unknown</span>
            </div>
            <div class="flex items-center justify-between">
              <span>OpenAI</span>
              <span id="openaiStatus" class="chip rounded-full px-3 py-1 text-xs">Unknown</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span>Uptime</span>
              <span id="uptime">0s</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span>Memory</span>
              <span id="memory">0 MB</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span>Data files</span>
              <span id="dataFiles">0 files</span>
            </div>
          </div>
          <div class="mt-5 border-t border-slate-800 pt-4">
            <label class="text-xs text-slate-400">Auto-refresh interval</label>
            <select id="refreshInterval" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
              <option value="5000">5 seconds</option>
              <option value="10000">10 seconds</option>
              <option value="15000">15 seconds</option>
            </select>
          </div>
        </div>
      </section>

      <section class="grid gap-6 lg:grid-cols-[1.2fr,1.3fr]">
        <div class="grid-card rounded-2xl p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-slate-300">Activity</p>
              <h2 class="mt-2 text-lg font-semibold">Unified Event Stream</h2>
            </div>
            <span class="text-xs text-slate-400">From data/*.jsonl</span>
          </div>
          <div id="activityFeed" class="mt-4 space-y-3"></div>
        </div>

        <div class="grid-card rounded-2xl p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs uppercase tracking-[0.2em] text-purple-200">Controls</p>
              <h2 class="mt-2 text-lg font-semibold">Run Controls</h2>
            </div>
            <span class="text-xs text-slate-400">Port ${port}</span>
          </div>
          <div class="mt-4 grid gap-3">
            <button id="toggleLoop" class="rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400" type="button">Start paper loop</button>
            <button id="runOnce" class="rounded-lg bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-400" type="button">Run once</button>
            <div class="grid gap-3 sm:grid-cols-2">
              <div>
                <label class="text-xs text-slate-400">Run ticks N</label>
                <input id="runTicksCount" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="1" value="5" />
              </div>
              <div>
                <label class="text-xs text-slate-400">Tick interval (ms)</label>
                <input id="runTicksInterval" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" value="5000" />
              </div>
            </div>
            <button id="runTicks" class="rounded-lg border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-cyan-400" type="button">Run ticks</button>
            <div class="grid gap-3 sm:grid-cols-2">
              <div>
                <label class="text-xs text-slate-400">Mode</label>
                <select id="modeSelect" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
                  <option value="paper">paper</option>
                  <option value="live">live</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-slate-400">Selector</label>
                <select id="selectorSelect" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
                  <option value="top_volume">top_volume</option>
                  <option value="easy_targets">easy_targets</option>
                  <option value="slugs">slugs</option>
                </select>
              </div>
            </div>
            <button id="resetData" class="rounded-lg border border-red-500/60 px-4 py-3 text-sm font-semibold text-red-200 transition hover:border-red-400" type="button">Reset data</button>
          </div>
        </div>
      </section>
    </main>

    <script>
      var refreshState = {
        auto: true,
        intervalMs: 10000,
        timer: null
      };
      var uiState = {
        running: false,
        mode: "paper",
        selector: "top_volume"
      };
      var riskState = {
        bankrollUsd: 0,
        settings: null,
        effective: null,
        tight: null,
        dirty: false
      };
      var pnlState = {
        range: "7d"
      };

      function byId(id) {
        return document.getElementById(id);
      }

      function setText(id, value) {
        var el = byId(id);
        if (el) {
          el.textContent = value;
        }
      }

      function setInputValue(id, value) {
        var el = byId(id);
        if (!el) return;
        if (document.activeElement === el) return;
        el.value = value;
      }

      function setBadge(el, state) {
        if (!el) return;
        var cls = "chip rounded-full px-3 py-1 text-xs";
        if (state === "connected") {
          el.className = cls + " bg-emerald-500/20 text-emerald-200";
          el.textContent = "Connected";
          return;
        }
        if (state === "rate_limited") {
          el.className = cls + " bg-amber-500/20 text-amber-200";
          el.textContent = "Rate limited";
          return;
        }
        if (state === "offline") {
          el.className = cls + " bg-red-500/20 text-red-200";
          el.textContent = "Offline";
          return;
        }
        el.className = cls + " bg-amber-500/20 text-amber-200";
        el.textContent = "Unknown";
      }

      function formatCurrency(value) {
        var num = Number(value || 0);
        var sign = num < 0 ? "-" : "";
        return sign + "$" + Math.abs(num).toFixed(2);
      }

      function formatPercent(value) {
        return Number(value || 0).toFixed(1) + "%";
      }

      function formatMaybe(value, fallback) {
        if (value === null || value === undefined || value === "") return fallback;
        return String(value);
      }

      function setWarning(id, on) {
        var el = byId(id);
        if (!el) return;
        if (on) {
          el.classList.remove("hidden");
        } else {
          el.classList.add("hidden");
        }
      }

      function formatTimeLabel(ts) {
        if (!ts) return "--";
        var date = new Date(ts);
        if (Number.isNaN(date.getTime())) return "--";
        return date.toLocaleString();
      }

      function fetchJson(url) {
        return fetch(url).then(function (res) { return res.json(); });
      }

      function fetchPnlSeries(range) {
        var url = "/api/pnl_series?range=" + encodeURIComponent(String(range || "7d"));
        return fetchJson(url);
      }

      function fetchLiveMarkets(limit, selector) {
        var url = "/api/markets/live?limit=" + encodeURIComponent(String(limit || 15)) + "&selector=" + encodeURIComponent(String(selector || "top_volume"));
        return fetch(url).then(function (res) {
          return res
            .json()
            .catch(function () { return {}; })
            .then(function (data) {
              return { ok: res.ok, status: res.status, data: data };
            });
        });
      }

      function renderMarkets(items) {
        var table = byId("marketsTable");
        if (!table) return;
        table.innerHTML = "";
        if (!items || items.length === 0) {
          var row = document.createElement("tr");
          var cell = document.createElement("td");
          cell.colSpan = 6;
          cell.className = "py-3 text-slate-400";
          cell.textContent = "No markets to display.";
          row.appendChild(cell);
          table.appendChild(row);
          return;
        }
        items.forEach(function (item) {
          var row = document.createElement("tr");
          var cells = [
            formatMaybe(item.slug, "--"),
            formatMaybe(item.title || item.question, "--"),
            item.volume != null ? Number(item.volume).toFixed(2) : "--",
            item.spread != null ? Number(item.spread).toFixed(4) : "--",
            item.midpoint != null ? Number(item.midpoint).toFixed(4) : "--",
            item.updatedAt ? new Date(item.updatedAt).toLocaleTimeString() : "--"
          ];
          cells.forEach(function (text) {
            var td = document.createElement("td");
            td.className = "py-2 pr-4";
            td.textContent = String(text);
            row.appendChild(td);
          });
          table.appendChild(row);
        });
      }

      function renderMarketsLoading() {
        var table = byId("marketsTable");
        if (!table) return;
        table.innerHTML = "";
        var row = document.createElement("tr");
        var cell = document.createElement("td");
        cell.colSpan = 6;
        cell.className = "py-3 text-slate-400";
        cell.textContent = "Loading live markets...";
        row.appendChild(cell);
        table.appendChild(row);
      }

      function renderMarketsStatus(payload) {
        var el = byId("marketsStatus");
        if (!el) return;
        var meta = byId("marketsMeta");
        var status = payload && payload.status ? payload.status : "ok";
        var message = "";
        var cls = "text-slate-400";
        if (status === "ok") {
          message = "Live markets loaded.";
          cls = "text-emerald-200";
        } else if (status === "partial") {
          message = payload.error || "Partial order books loaded.";
          cls = "text-amber-200";
        } else if (status === "rate_limited") {
          message = payload.error || "Rate limited. Retrying soon.";
          cls = "text-amber-200";
        } else if (status === "offline") {
          message = payload.error || "Offline: cannot reach Polymarket.";
          cls = "text-red-200";
        } else if (status === "empty") {
          message = "No markets returned.";
          cls = "text-slate-400";
        } else if (status === "loading") {
          message = "Loading live markets...";
          cls = "text-slate-400";
        }
        el.textContent = message;
        el.className = cls;
        if (meta) {
          var parts = [];
          if (payload && payload.cached) parts.push("cached");
          if (payload && payload.ageMs != null) {
            parts.push(Math.round(Number(payload.ageMs) / 1000) + "s old");
          }
          meta.textContent = parts.join(" • ");
        }
      }

      function renderPositions(items) {
        var table = byId("positionsTable");
        if (!table) return;
        table.innerHTML = "";
        if (!items || items.length === 0) {
          var row = document.createElement("tr");
          var cell = document.createElement("td");
          cell.colSpan = 5;
          cell.className = "py-3 text-slate-400";
          cell.textContent = "No open positions.";
          row.appendChild(cell);
          table.appendChild(row);
          return;
        }
        items.forEach(function (item) {
          var row = document.createElement("tr");
          var pnl = item.pnl != null ? Number(item.pnl) : null;
          var pnlText = pnl != null ? formatCurrency(pnl) : "--";
          var cells = [
            item.market || "--",
            item.sizeUsd != null ? Number(item.sizeUsd).toFixed(2) : "--",
            item.entryPrice != null ? Number(item.entryPrice).toFixed(4) : "--",
            item.markPrice != null ? Number(item.markPrice).toFixed(4) : "--",
            pnlText
          ];
          cells.forEach(function (text, idx) {
            var td = document.createElement("td");
            td.className = "py-2 pr-4";
            if (idx === 4 && pnl != null) {
              td.className += pnl >= 0 ? " text-emerald-300" : " text-red-300";
            }
            td.textContent = String(text);
            row.appendChild(td);
          });
          table.appendChild(row);
        });
      }

      function renderFills(items) {
        var feed = byId("fillsFeed");
        if (!feed) return;
        feed.innerHTML = "";
        if (!items || items.length === 0) {
          var empty = document.createElement("div");
          empty.className = "text-sm text-slate-400";
          empty.textContent = "No paper fills yet.";
          feed.appendChild(empty);
          return;
        }
        items.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs";
          var title = document.createElement("div");
          title.className = "flex items-center justify-between";
          var left = document.createElement("span");
          left.className = "text-slate-200";
          left.textContent = item.market + " " + item.side;
          var right = document.createElement("span");
          right.className = "text-slate-400";
          right.textContent = item.time;
          title.appendChild(left);
          title.appendChild(right);
          var meta = document.createElement("div");
          meta.className = "mt-1 text-slate-400";
          meta.textContent = "Price " + formatMaybe(item.price, "--") + " | Size " + formatMaybe(item.sizeUsd, "--") + (item.reason ? " | " + item.reason : "");
          card.appendChild(title);
          card.appendChild(meta);
          feed.appendChild(card);
        });
      }

      function renderAnalyses(items) {
        var list = byId("analysisList");
        if (!list) return;
        list.innerHTML = "";
        if (!items || items.length === 0) {
          var empty = document.createElement("div");
          empty.className = "text-sm text-slate-400";
          empty.textContent = "No analyses yet.";
          list.appendChild(empty);
          return;
        }
        items.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs";
          var header = document.createElement("div");
          header.className = "flex items-center justify-between";
          var title = document.createElement("span");
          title.className = "text-slate-100";
          title.textContent = item.market;
          var meta = document.createElement("span");
          meta.className = "text-slate-400";
          meta.textContent = item.updatedAt ? new Date(item.updatedAt).toLocaleTimeString() : "--";
          header.appendChild(title);
          header.appendChild(meta);
          var row = document.createElement("div");
          row.className = "mt-2 flex flex-wrap gap-3 text-slate-300";
          row.textContent = "Prob " + formatMaybe(item.probability, "--") + " | Conf " + formatMaybe(item.confidence, "--") + " | Tokens " + formatMaybe(item.tokens, "--") + " | Cost " + formatMaybe(item.cost != null ? formatCurrency(item.cost) : "--", "--");
          var rationale = document.createElement("div");
          rationale.className = "mt-2 text-slate-400";
          rationale.textContent = item.rationale;
          card.appendChild(header);
          card.appendChild(row);
          card.appendChild(rationale);
          list.appendChild(card);
        });
      }

      function renderActivity(items) {
        var feed = byId("activityFeed");
        if (!feed) return;
        feed.innerHTML = "";
        if (!items || items.length === 0) {
          var empty = document.createElement("div");
          empty.className = "text-sm text-slate-400";
          empty.textContent = "No activity yet.";
          feed.appendChild(empty);
          return;
        }
        items.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3";
          var header = document.createElement("div");
          header.className = "flex items-center justify-between text-xs";
          var left = document.createElement("span");
          left.className = "text-slate-400";
          left.textContent = item.time + " • " + item.type;
          var right = document.createElement("span");
          right.className = "text-slate-500";
          right.textContent = item.value || item.source;
          header.appendChild(left);
          header.appendChild(right);
          var desc = document.createElement("div");
          desc.className = "mt-2 text-sm text-slate-200";
          desc.textContent = item.description;
          card.appendChild(header);
          card.appendChild(desc);
          feed.appendChild(card);
        });
      }

      function setPnlButtons(range) {
        var buttons = document.querySelectorAll(".pnl-range-btn");
        buttons.forEach(function (btn) {
          var isActive = btn.getAttribute("data-range") === range;
          btn.className = isActive
            ? "pnl-range-btn rounded-full border border-emerald-400/60 bg-emerald-400/10 px-3 py-1 text-emerald-100"
            : "pnl-range-btn rounded-full border border-slate-700 px-3 py-1 text-slate-300 transition hover:border-emerald-300";
        });
      }

      function buildPnlSvg(points, width, height) {
        if (!points || points.length === 0) return "";
        var padding = 24;
        var min = Number.POSITIVE_INFINITY;
        var max = Number.NEGATIVE_INFINITY;
        points.forEach(function (point) {
          if (point.v < min) min = point.v;
          if (point.v > max) max = point.v;
        });
        if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
        if (min === max) {
          min -= 1;
          max += 1;
        }
        var range = max - min;
        var plotW = width - padding * 2;
        var plotH = height - padding * 2;
        var path = "";
        points.forEach(function (point, idx) {
          var x = padding + (idx / Math.max(1, points.length - 1)) * plotW;
          var y = padding + (1 - (point.v - min) / range) * plotH;
          path += (idx === 0 ? "M" : " L") + x.toFixed(2) + " " + y.toFixed(2);
        });
        var last = points[points.length - 1];
        var lastX = padding + plotW;
        var lastY = padding + (1 - (last.v - min) / range) * plotH;
        var area = path + " L " + lastX.toFixed(2) + " " + (padding + plotH).toFixed(2) +
          " L " + padding.toFixed(2) + " " + (padding + plotH).toFixed(2) + " Z";
        var grid = "";
        for (var i = 0; i <= 2; i += 1) {
          var yLine = padding + (plotH / 2) * i;
          grid += '<line x1="' + padding + '" y1="' + yLine.toFixed(2) +
            '" x2="' + (padding + plotW) + '" y2="' + yLine.toFixed(2) +
            '" stroke="rgba(148,163,184,0.2)" stroke-width="1" />';
        }
        var stroke = last.v >= 0 ? "#34d399" : "#f87171";
        var fill = last.v >= 0 ? "rgba(52,211,153,0.16)" : "rgba(248,113,113,0.16)";
        return (
          '<rect width="100%" height="100%" fill="none" />' +
          grid +
          '<path d="' + area + '" fill="' + fill + '" />' +
          '<path d="' + path + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" />' +
          '<circle cx="' + lastX.toFixed(2) + '" cy="' + lastY.toFixed(2) + '" r="4" fill="' + stroke + '" />'
        );
      }

      function renderPnlSeries(payload, range) {
        var series = (payload && payload.series) || [];
        var points = series
          .map(function (item) {
            return { t: Date.parse(item.t), v: Number(item.v) };
          })
          .filter(function (item) { return Number.isFinite(item.t) && Number.isFinite(item.v); });
        var stats = payload && payload.stats ? payload.stats : {};
        var current = Number(stats.current || 0);
        var daily = Number(stats.dailyChange || 0);
        var drawdown = Number(stats.drawdown || 0);
        var low = Number(stats.low || 0);
        var high = Number(stats.high || 0);
        var rangeStart = stats.rangeStart;
        var rangeEnd = stats.rangeEnd;

        var empty = byId("pnlEmpty");
        var wrap = byId("pnlChartWrap");
        var svg = byId("pnlChart");
        if (empty && wrap) {
          if (points.length < 2) {
            empty.classList.remove("hidden");
            wrap.classList.add("hidden");
          } else {
            empty.classList.add("hidden");
            wrap.classList.remove("hidden");
          }
        }
        if (svg && points.length >= 2) {
          svg.innerHTML = buildPnlSvg(points, 640, 240);
        } else if (svg) {
          svg.innerHTML = "";
        }

        var currentEl = byId("pnlCurrent");
        if (currentEl) {
          currentEl.textContent = formatCurrency(current);
          currentEl.className = "mt-2 text-xl font-semibold " + (current >= 0 ? "text-emerald-300" : "text-red-300");
        }
        var dailyEl = byId("pnlDaily");
        if (dailyEl) {
          dailyEl.textContent = formatCurrency(daily);
          dailyEl.className = "mt-2 text-xl font-semibold " + (daily >= 0 ? "text-emerald-300" : "text-red-300");
        }
        var drawdownEl = byId("pnlDrawdown");
        if (drawdownEl) drawdownEl.textContent = formatCurrency(drawdown);
        setText("pnlRangeLabel", "Range: " + (range || payload.range || "7d"));
        setText("pnlPoints", String(points.length));
        setText("pnlHigh", formatCurrency(high));
        setText("pnlLow", formatCurrency(low));
        setText("pnlRangeStart", rangeStart ? new Date(rangeStart).toLocaleString() : "--");
        setText("pnlRangeEnd", rangeEnd ? new Date(rangeEnd).toLocaleString() : "--");
        setText("pnlUpdated", payload && payload.updatedAt ? "Updated " + new Date(payload.updatedAt).toLocaleTimeString() : "Updated --");
      }

      function populateMarketSelect(items) {
        var select = byId("analysisMarket");
        if (!select) return;
        select.innerHTML = "";
        if (!items || items.length === 0) {
          var opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "No markets yet";
          select.appendChild(opt);
          return;
        }
        items.forEach(function (item) {
          var opt = document.createElement("option");
          opt.value = item.slug || item.id || "";
          opt.textContent = item.slug || item.title || item.question || item.id;
          select.appendChild(opt);
        });
      }

      function setRunningState(running) {
        uiState.running = running;
        var statusText = byId("statusText");
        var statusDot = byId("statusDot");
        var toggle = byId("toggleLoop");
        if (statusText) statusText.textContent = running ? "RUNNING" : "STOPPED";
        if (statusDot) {
          statusDot.className = running
            ? "h-2.5 w-2.5 rounded-full bg-emerald-400 pulse-dot"
            : "h-2.5 w-2.5 rounded-full bg-red-400";
        }
        if (toggle) {
          toggle.textContent = running ? "Stop loop" : "Start paper loop";
          toggle.className = running
            ? "rounded-lg bg-red-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-400"
            : "rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400";
        }
      }

      function setRefreshInterval(ms) {
        var minMs = Number(document.body.getAttribute("data-refresh-min") || 5000);
        var maxMs = Number(document.body.getAttribute("data-refresh-max") || 10000);
        var clamped = Math.min(maxMs, Math.max(minMs, ms));
        refreshState.intervalMs = clamped;
        var label = byId("refreshLabel");
        if (label) label.textContent = "Auto-refresh " + Math.round(clamped / 1000) + "s";
        var select = byId("refreshInterval");
        if (select) select.value = String(clamped);
        if (refreshState.timer) {
          clearInterval(refreshState.timer);
          refreshState.timer = null;
        }
        refreshState.timer = setInterval(function () {
          refreshDashboard();
        }, clamped);
        try {
          localStorage.setItem("pm_refresh_ms", String(clamped));
        } catch (err) {
          // ignore
        }
      }

      function applySummary(summary) {
        setText("marketsAnalyzed", String(summary.stats.marketsAnalyzedToday || 0));
        setText("openPositions", String(summary.stats.openPositions || 0));
        var pnlValue = Number(summary.stats.totalPnl || 0);
        var pnlEl = byId("totalPnl");
        if (pnlEl) {
          pnlEl.textContent = formatCurrency(pnlValue);
          pnlEl.className = "mt-2 text-2xl font-semibold " + (pnlValue >= 0 ? "text-emerald-300" : "text-red-300");
        }
        setText("llmCost", formatCurrency(summary.llm.costToday || 0));
        setText("llmCostHour", "Hour: " + formatCurrency(summary.llm.costHour || 0));
        setText(
          "llmRemaining",
          "Remaining: " +
            formatCurrency(summary.llm.remainingDay || 0) +
            " day / " +
            formatCurrency(summary.llm.remainingHour || 0) +
            " hr"
        );
        setText("lastRun", summary.status.lastRunTime ? "Last run: " + summary.status.lastRunTime : "Last run: --");
        setText("modeBadge", summary.status.mode);
        setText("selectorBadge", summary.status.selector);
        uiState.selector = summary.status.selector;
        setText("bankroll", formatCurrency(summary.strategy.bankrollUsd || 0));
        setText("maxPosition", formatCurrency(summary.strategy.maxPositionUsd || 0));
        setText("riskPercent", formatPercent(summary.strategy.riskPercent || 0));
        setText("fractionalKelly", Number(summary.strategy.fractionalKelly || 0).toFixed(2));
        setText("spreadFilter", "Spread filter: " + summary.strategy.spreadFilter);
        setText("depthFilter", "Depth filter: " + summary.strategy.depthFilter);
        setText("uptime", Math.round(summary.health.uptimeSec || 0) + "s");
        setText("memory", Number(summary.health.memoryMb || 0).toFixed(1) + " MB");
        setText("dataFiles", summary.health.dataFiles.count + " files / " + summary.health.dataFiles.totalLines + " lines");
        setBadge(byId("clobStatus"), summary.health.clob);
        setBadge(byId("gammaStatus"), summary.health.gamma);
        setBadge(byId("openaiStatus"), summary.health.openai);
        var clobDetail = byId("clobDetail");
        if (clobDetail) {
          var showDetail = (summary.health.clob === "offline" || summary.health.clob === "rate_limited") && summary.health.clobDetail;
          if (showDetail) {
            clobDetail.textContent = summary.health.clobDetail;
            clobDetail.className = "text-xs text-slate-400";
          } else {
            clobDetail.textContent = "";
            clobDetail.className = "text-xs text-slate-400 hidden";
          }
        }
        setRunningState(summary.status.running);
        var modeSelect = byId("modeSelect");
        if (modeSelect) modeSelect.value = summary.status.mode;
        var selectorSelect = byId("selectorSelect");
        if (selectorSelect) selectorSelect.value = summary.status.selector;
        if (summary.status.paperOnly && modeSelect) {
          modeSelect.disabled = true;
          modeSelect.className = "mt-2 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-500";
        }
        var closeBtn = byId("closeAll");
        if (closeBtn) {
          closeBtn.disabled = summary.status.mode !== "paper";
          closeBtn.className = summary.status.mode === "paper"
            ? "rounded-full border border-amber-400/50 px-4 py-2 text-xs font-semibold text-amber-200 transition hover:border-amber-300"
            : "rounded-full border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-500";
        }
        if (summary.risk) {
          applyRiskSummary(summary.risk, summary.strategy.bankrollUsd || 0);
        }
      }

      function applyRiskSummary(risk, bankrollUsd) {
        riskState.bankrollUsd = Number(bankrollUsd || 0);
        riskState.settings = risk.settings || {};
        riskState.effective = risk.effective || {};
        riskState.tight = risk.tight || {};

        setText("riskEffectiveMaxPos", formatCurrency(risk.effective.maxPosUsd || 0));
        setText("riskKellyCap", "Kelly cap: " + formatCurrency(risk.effective.kellyCapUsd || 0));
        setText(
          "riskDailyLossCap",
          "Daily loss cap: " +
            formatCurrency(risk.effective.maxDailyLossUsd || 0) +
            " (" +
            formatPercent(risk.effective.maxDailyLossPct || 0) +
            ")"
        );
        setText(
          "riskMaxPositionsCap",
          "Max positions: " + String(risk.effective.maxPositions != null ? risk.effective.maxPositions : "--")
        );

        if (!riskState.dirty) {
          setInputValue("kellyFractionRange", Number(risk.settings.kellyFraction || 0).toFixed(2));
          setInputValue("kellyFractionInput", Number(risk.settings.kellyFraction || 0).toFixed(2));
          setInputValue("maxPosUsdInput", Number(risk.settings.maxPosUsd || 0).toFixed(2));
          setInputValue(
            "maxPosPctInput",
            riskState.bankrollUsd > 0
              ? ((Number(risk.settings.maxPosUsd || 0) / riskState.bankrollUsd) * 100).toFixed(1)
              : "0.0"
          );
          setInputValue("maxDailyLossUsdInput", Number(risk.settings.maxDailyLossUsd || 0).toFixed(2));
          setInputValue("maxPositionsInput", String(risk.settings.maxPositions || 0));
          setInputValue("spreadBpsInput", Number(risk.settings.spreadBps || 0).toFixed(1));
          setInputValue("minDepthUsdInput", Number(risk.settings.minDepthUsd || 0).toFixed(0));
        }

        setText(
          "dailyLossPctLabel",
          formatPercent(risk.effective.maxDailyLossPct || 0) + " bankroll"
        );

        setWarning("kellyWarning", !!risk.tight.kellyFraction);
        setWarning("maxPosWarning", !!risk.tight.maxPosUsd);
        setWarning("dailyLossWarning", !!risk.tight.maxDailyLossUsd);
        setWarning("positionsWarning", !!risk.tight.maxPositions);
        setWarning("spreadWarning", !!risk.tight.spreadBps);
        setWarning("depthWarning", !!risk.tight.minDepthUsd);

        if (!riskState.dirty) {
          var status = byId("riskSaveStatus");
          if (status) status.textContent = "Settings synced.";
        }
      }

      function refreshMarkets() {
        renderMarketsLoading();
        renderMarketsStatus({ status: "loading" });
        var selector = uiState.selector || "top_volume";
        return fetchLiveMarkets(15, selector)
          .then(function (result) {
            var payload = result.data || {};
            renderMarkets(payload.items || []);
            populateMarketSelect(payload.items || []);
            renderMarketsStatus(payload);
          })
          .catch(function () {
            renderMarkets([]);
            renderMarketsStatus({ status: "offline", error: "Unable to reach server." });
          });
      }

      function refreshDashboard() {
        return fetchJson("/api/summary")
          .then(function (summary) {
            applySummary(summary);
            return Promise.all([
              refreshMarkets(),
              fetchJson("/api/positions"),
              fetchJson("/api/analyses"),
              fetchJson("/api/activity"),
              fetchPnlSeries(pnlState.range)
            ]).then(function (results) {
              renderPositions(results[1].positions || []);
              renderFills(results[1].fills || []);
              renderAnalyses(results[2].items || []);
              renderActivity(results[3].items || []);
              renderPnlSeries(results[4], pnlState.range);
            });
          })
          .catch(function () {
            renderMarketsStatus({ status: "offline", error: "Unable to refresh dashboard." });
          });
      }

      function postAction(payload) {
        return fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (res) { return res.json(); });
      }

      function setRiskDirty(dirty) {
        riskState.dirty = dirty;
        var status = byId("riskSaveStatus");
        if (status) {
          status.textContent = dirty ? "Unsaved changes." : "Settings synced.";
        }
      }

      function readRiskForm() {
        var kelly = Number(byId("kellyFractionInput").value || 0);
        var maxPosUsd = Number(byId("maxPosUsdInput").value || 0);
        var maxDailyLossUsd = Number(byId("maxDailyLossUsdInput").value || 0);
        var maxPositions = Number(byId("maxPositionsInput").value || 0);
        var spreadBps = Number(byId("spreadBpsInput").value || 0);
        var minDepthUsd = Number(byId("minDepthUsdInput").value || 0);
        return {
          kellyFraction: kelly,
          maxPosUsd: maxPosUsd,
          maxDailyLossUsd: maxDailyLossUsd,
          maxPositions: maxPositions,
          spreadBps: spreadBps,
          minDepthUsd: minDepthUsd
        };
      }

      function syncKellyInputs(value) {
        var clamped = Math.min(1, Math.max(0, Number(value || 0)));
        setInputValue("kellyFractionRange", clamped.toFixed(2));
        setInputValue("kellyFractionInput", clamped.toFixed(2));
      }

      function syncMaxPosFromPercent(value) {
        var pct = Math.max(0, Number(value || 0));
        var usd = riskState.bankrollUsd > 0 ? (pct / 100) * riskState.bankrollUsd : 0;
        setInputValue("maxPosUsdInput", usd.toFixed(2));
      }

      function syncPercentFromMaxPos(value) {
        var usd = Math.max(0, Number(value || 0));
        var pct = riskState.bankrollUsd > 0 ? (usd / riskState.bankrollUsd) * 100 : 0;
        setInputValue("maxPosPctInput", pct.toFixed(1));
      }

      var refreshSelect = byId("refreshInterval");
      if (refreshSelect) {
        refreshSelect.addEventListener("change", function (event) {
          var value = Number(event.target.value || 10000);
          setRefreshInterval(value);
        });
      }

      var kellyRange = byId("kellyFractionRange");
      if (kellyRange) {
        kellyRange.addEventListener("input", function (event) {
          syncKellyInputs(event.target.value);
          setRiskDirty(true);
        });
      }

      var kellyInput = byId("kellyFractionInput");
      if (kellyInput) {
        kellyInput.addEventListener("input", function (event) {
          syncKellyInputs(event.target.value);
          setRiskDirty(true);
        });
      }

      var maxPosUsdInput = byId("maxPosUsdInput");
      if (maxPosUsdInput) {
        maxPosUsdInput.addEventListener("input", function (event) {
          syncPercentFromMaxPos(event.target.value);
          setRiskDirty(true);
        });
      }

      var maxPosPctInput = byId("maxPosPctInput");
      if (maxPosPctInput) {
        maxPosPctInput.addEventListener("input", function (event) {
          syncMaxPosFromPercent(event.target.value);
          setRiskDirty(true);
        });
      }

      var maxDailyLossUsdInput = byId("maxDailyLossUsdInput");
      if (maxDailyLossUsdInput) {
        maxDailyLossUsdInput.addEventListener("input", function () {
          setRiskDirty(true);
        });
      }

      var maxPositionsInput = byId("maxPositionsInput");
      if (maxPositionsInput) {
        maxPositionsInput.addEventListener("input", function () {
          setRiskDirty(true);
        });
      }

      var spreadBpsInput = byId("spreadBpsInput");
      if (spreadBpsInput) {
        spreadBpsInput.addEventListener("input", function () {
          setRiskDirty(true);
        });
      }

      var minDepthUsdInput = byId("minDepthUsdInput");
      if (minDepthUsdInput) {
        minDepthUsdInput.addEventListener("input", function () {
          setRiskDirty(true);
        });
      }

      var saveRiskBtn = byId("saveRisk");
      if (saveRiskBtn) {
        saveRiskBtn.addEventListener("click", function () {
          var status = byId("riskSaveStatus");
          if (status) status.textContent = "Saving...";
          var payload = readRiskForm();
          postAction({
            action: "set_risk_params",
            kellyFraction: payload.kellyFraction,
            maxPosUsd: payload.maxPosUsd,
            maxDailyLossUsd: payload.maxDailyLossUsd,
            maxPositions: payload.maxPositions,
            spreadBps: payload.spreadBps,
            minDepthUsd: payload.minDepthUsd
          }).then(function () {
            setRiskDirty(false);
            refreshDashboard();
          }).catch(function () {
            if (status) status.textContent = "Save failed.";
          });
        });
      }

      var toggleLoop = byId("toggleLoop");
      if (toggleLoop) {
        toggleLoop.addEventListener("click", function () {
          if (uiState.running) {
            postAction({ action: "stop" }).then(refreshDashboard);
          } else {
            var intervalValue = Number(byId("runTicksInterval").value || 5000);
            postAction({ action: "run_ticks", ticks: 0, intervalMs: intervalValue }).then(refreshDashboard);
          }
        });
      }

      var runOnceBtn = byId("runOnce");
      if (runOnceBtn) {
        runOnceBtn.addEventListener("click", function () {
          postAction({ action: "run_once" }).then(refreshDashboard);
        });
      }

      var runTicksBtn = byId("runTicks");
      if (runTicksBtn) {
        runTicksBtn.addEventListener("click", function () {
          var countValue = Number(byId("runTicksCount").value || 1);
          var intervalValue = Number(byId("runTicksInterval").value || 0);
          postAction({ action: "run_ticks", ticks: countValue, intervalMs: intervalValue }).then(refreshDashboard);
        });
      }

      var modeSelect = byId("modeSelect");
      if (modeSelect) {
        modeSelect.addEventListener("change", function (event) {
          postAction({ action: "set_mode", value: event.target.value }).then(refreshDashboard);
        });
      }

      var selectorSelect = byId("selectorSelect");
      if (selectorSelect) {
        selectorSelect.addEventListener("change", function (event) {
          postAction({ action: "set_selector", value: event.target.value }).then(refreshDashboard);
        });
      }

      var resetBtn = byId("resetData");
      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          postAction({ action: "reset" }).then(refreshDashboard);
        });
      }

      var closeAllBtn = byId("closeAll");
      if (closeAllBtn) {
        closeAllBtn.addEventListener("click", function () {
          postAction({ action: "close_all" }).then(refreshDashboard);
        });
      }

      var refreshMarketsBtn = byId("refreshMarkets");
      if (refreshMarketsBtn) {
        refreshMarketsBtn.addEventListener("click", function () {
          refreshMarkets();
        });
      }

      var pnlButtons = document.querySelectorAll(".pnl-range-btn");
      pnlButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
          var range = btn.getAttribute("data-range") || "7d";
          pnlState.range = range;
          setPnlButtons(range);
          fetchPnlSeries(range)
            .then(function (payload) { renderPnlSeries(payload, range); })
            .catch(function () { renderPnlSeries({ series: [], stats: {} }, range); });
        });
      });

      var runAnalysisBtn = byId("runAnalysis");
      if (runAnalysisBtn) {
        runAnalysisBtn.addEventListener("click", function () {
          var select = byId("analysisMarket");
          var chosen = select ? select.value : "";
          if (chosen) {
            postAction({ action: "set_selector", value: "slugs", slugs: chosen }).then(function () {
              return postAction({ action: "run_once" });
            }).then(refreshDashboard);
          } else {
            postAction({ action: "run_once" }).then(refreshDashboard);
          }
        });
      }

      var stored = null;
      try {
        stored = localStorage.getItem("pm_refresh_ms");
      } catch (err) {
        stored = null;
      }
      var initialMs = Number(stored || document.body.getAttribute("data-refresh-ms") || 10000);
      if (!Number.isFinite(initialMs)) initialMs = 10000;
      setPnlButtons(pnlState.range);
      setRefreshInterval(initialMs);
      refreshDashboard();
    </script>
  </body>
</html>`;
}

function renderMarketsPage(port: number) {
  return `<!doctype html>
<html class="h-full" lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#0b1020" />
    <title>Polymarket Markets</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: {
              display: ["Space Grotesk", "ui-sans-serif", "system-ui"],
              body: ["IBM Plex Sans", "ui-sans-serif", "system-ui"]
            },
            boxShadow: {
              glow: "0 0 60px rgba(14, 116, 144, 0.2)"
            }
          }
        }
      };
    </script>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
    <style>
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 999px; }
      ::-webkit-scrollbar-track { background: #0b1020; }
      .grid-card { background: rgba(15, 23, 42, 0.78); border: 1px solid rgba(148, 163, 184, 0.2); }
      .soft-ring { box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.2); }
      .fade-in { animation: fade 0.5s ease-out; }
      @keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body class="min-h-full bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-100 font-body">
    <div class="absolute inset-0 pointer-events-none">
      <div class="absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-cyan-500/10 blur-3xl"></div>
      <div class="absolute top-1/3 right-0 h-80 w-80 translate-x-1/3 rounded-full bg-emerald-500/10 blur-3xl"></div>
      <div class="absolute bottom-0 left-0 h-72 w-72 -translate-x-1/3 rounded-full bg-sky-400/10 blur-3xl"></div>
    </div>
    <main class="relative mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8 lg:px-10">
      <header class="grid-card rounded-3xl p-6 shadow-glow">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p class="text-xs uppercase tracking-[0.24em] text-cyan-200">Live Markets</p>
            <h1 class="mt-2 text-2xl font-semibold font-display">Polymarket Markets</h1>
            <p class="mt-2 text-sm text-slate-400">Browse live markets with pagination, filters, and sorting.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <a class="rounded-full border border-slate-700 px-4 py-2 text-slate-200 transition hover:border-cyan-400" href="/">Overview</a>
            <button id="refreshMarkets" class="rounded-full border border-slate-700 px-4 py-2 text-slate-200 transition hover:border-cyan-400" type="button">Refresh</button>
          </div>
        </div>
        <div class="mt-5 grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
          <div class="grid-card rounded-2xl p-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-slate-300">Filters</p>
                <p class="mt-1 text-sm text-slate-400">Fine tune the market list.</p>
              </div>
              <div class="text-xs text-slate-400">
                <span id="resultsMeta">0 markets</span>
              </div>
            </div>
            <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label class="text-xs text-slate-400">Selector</label>
                <select id="filterSelector" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
                  <option value="top_volume">top_volume</option>
                  <option value="easy_targets">easy_targets</option>
                  <option value="slugs">slugs</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-slate-400">Min volume (USD)</label>
                <input id="filterMinVolume" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" placeholder="0" />
              </div>
              <div>
                <label class="text-xs text-slate-400">Max spread (bps)</label>
                <input id="filterMaxSpread" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" placeholder="0" />
              </div>
              <div>
                <label class="text-xs text-slate-400">Min liquidity (USD)</label>
                <input id="filterMinLiquidity" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="number" min="0" placeholder="0" />
              </div>
              <div class="sm:col-span-2">
                <label class="text-xs text-slate-400">Search</label>
                <input id="filterQuery" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100" type="text" placeholder="Search slug or question" />
              </div>
            </div>
            <div class="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-400">
              <label class="flex items-center gap-2">
                <input id="filterActiveOnly" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-400" checked />
                Active only
              </label>
              <label class="flex items-center gap-2">
                <input id="filterIncludeResolved" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-400" />
                Include resolved
              </label>
            </div>
            <div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
              <div class="flex flex-wrap items-center gap-3">
                <label class="flex items-center gap-2">
                  <input id="autoRefreshToggle" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-400" />
                  Auto-refresh
                </label>
                <span id="lastUpdated">Last updated: --</span>
              </div>
              <div id="marketsStatus" class="text-slate-400">Loading markets...</div>
            </div>
          </div>
          <div class="grid-card rounded-2xl p-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-slate-300">Sort</p>
                <p class="mt-1 text-sm text-slate-400">Order the results.</p>
              </div>
            </div>
            <div class="mt-4 space-y-4">
              <div>
                <label class="text-xs text-slate-400">Sort by</label>
                <select id="sortSelect" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
                  <option value="volume_desc">Volume (desc)</option>
                  <option value="spread_asc">Spread (asc)</option>
                  <option value="updated_desc">Updated (desc)</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-slate-400">Page size</label>
                <select id="pageSizeSelect" class="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100">
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
              </div>
              <div class="rounded-2xl bg-slate-950/60 p-4 soft-ring text-xs text-slate-400">
                <div class="flex items-center justify-between">
                  <span>Page</span>
                  <span id="pageLabel">1</span>
                </div>
                <div class="mt-2 flex items-center justify-between">
                  <span>Showing</span>
                  <span id="pageRange">--</span>
                </div>
                <div class="mt-2 flex items-center justify-between">
                  <span>Total</span>
                  <span id="totalCount">0</span>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button id="prevPage" class="flex-1 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400" type="button">Prev</button>
                <button id="nextPage" class="flex-1 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400" type="button">Next</button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section class="grid-card rounded-3xl p-6 shadow-glow">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs uppercase tracking-[0.2em] text-emerald-200">Market Table</p>
            <h2 class="mt-2 text-lg font-semibold">Live Markets</h2>
          </div>
          <div id="marketsMeta" class="text-xs text-slate-400"></div>
        </div>

        <div class="mt-4 hidden overflow-x-auto md:block">
          <table class="min-w-full text-left text-xs">
            <thead class="sticky top-0 z-10 bg-slate-950 text-slate-400">
              <tr>
                <th class="px-3 py-2">Slug</th>
                <th class="px-3 py-2">Title</th>
                <th class="px-3 py-2 text-right">Volume</th>
                <th class="px-3 py-2 text-right">Liquidity</th>
                <th class="px-3 py-2 text-right">Spread</th>
                <th class="px-3 py-2 text-right">Midpoint</th>
                <th class="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody id="marketsTable" class="text-slate-100"></tbody>
          </table>
        </div>

        <div id="marketsCards" class="mt-4 grid gap-3 md:hidden"></div>
      </section>
    </main>

    <script>
      var state = {
        selector: "top_volume",
        sort: "volume_desc",
        limit: 25,
        offset: 0,
        minVolume: "",
        maxSpreadBps: "",
        minLiquidityUsd: "",
        q: "",
        activeOnly: true,
        includeResolved: false,
        totalCount: 0,
        lastUpdated: null,
        autoRefresh: false,
        timer: null
      };

      function byId(id) {
        return document.getElementById(id);
      }

      function setText(id, value) {
        var el = byId(id);
        if (el) el.textContent = value;
      }

      function formatNumber(value, digits) {
        if (value === null || value === undefined || value === "") return "--";
        var num = Number(value);
        if (!Number.isFinite(num)) return "--";
        return num.toFixed(digits);
      }

      function formatCurrency(value) {
        if (value === null || value === undefined || value === "") return "--";
        var num = Number(value);
        if (!Number.isFinite(num)) return "--";
        return "$" + num.toFixed(2);
      }

      function formatTime(ts) {
        if (!ts) return "--";
        var date = new Date(ts);
        if (Number.isNaN(date.getTime())) return "--";
        return date.toLocaleString();
      }

      function buildQuery() {
        var params = [];
        params.push("limit=" + encodeURIComponent(String(state.limit)));
        params.push("offset=" + encodeURIComponent(String(state.offset)));
        params.push("selector=" + encodeURIComponent(String(state.selector)));
        params.push("sort=" + encodeURIComponent(String(state.sort)));
        if (state.minVolume) params.push("min_volume=" + encodeURIComponent(String(state.minVolume)));
        if (state.maxSpreadBps) params.push("max_spread_bps=" + encodeURIComponent(String(state.maxSpreadBps)));
        if (state.minLiquidityUsd) params.push("min_liquidity_usd=" + encodeURIComponent(String(state.minLiquidityUsd)));
        if (state.q) params.push("q=" + encodeURIComponent(String(state.q)));
        params.push("active_only=" + encodeURIComponent(String(state.activeOnly)));
        params.push("include_resolved=" + encodeURIComponent(String(state.includeResolved)));
        return "/api/markets/live?" + params.join("&");
      }

      function renderStatus(payload) {
        var el = byId("marketsStatus");
        var meta = byId("marketsMeta");
        if (!el) return;
        var status = payload && payload.status ? payload.status : "ok";
        var message = "";
        var cls = "text-slate-400";
        if (status === "ok") {
          message = "Markets loaded.";
          cls = "text-emerald-200";
        } else if (status === "partial") {
          message = payload.error || "Partial order books loaded.";
          cls = "text-amber-200";
        } else if (status === "rate_limited") {
          message = payload.error || "Rate limited. Retrying soon.";
          cls = "text-amber-200";
        } else if (status === "offline") {
          message = payload.error || "Offline: cannot reach Polymarket.";
          cls = "text-red-200";
        } else if (status === "empty") {
          message = "No markets returned.";
          cls = "text-slate-400";
        } else if (status === "loading") {
          message = "Loading markets...";
          cls = "text-slate-400";
        }
        el.textContent = message;
        el.className = cls;
        if (meta) {
          var parts = [];
          if (payload && payload.cached) parts.push("cached");
          if (payload && payload.ageMs != null) parts.push(Math.round(Number(payload.ageMs) / 1000) + "s old");
          meta.textContent = parts.join(" • ");
        }
      }

      function renderTable(items) {
        var table = byId("marketsTable");
        if (!table) return;
        table.innerHTML = "";
        if (!items || items.length === 0) {
          var emptyRow = document.createElement("tr");
          var emptyCell = document.createElement("td");
          emptyCell.colSpan = 7;
          emptyCell.className = "px-3 py-4 text-slate-400";
          emptyCell.textContent = "No markets to display.";
          emptyRow.appendChild(emptyCell);
          table.appendChild(emptyRow);
          return;
        }
        items.forEach(function (item, idx) {
          var row = document.createElement("tr");
          row.className = (idx % 2 === 0 ? "bg-slate-950/60" : "bg-slate-900/60") + " fade-in";
          var cells = [
            { text: item.slug || "--", cls: "px-3 py-3" },
            { text: item.title || "--", cls: "px-3 py-3" },
            { text: formatCurrency(item.volume), cls: "px-3 py-3 text-right font-mono" },
            { text: formatCurrency(item.liquidityUsd), cls: "px-3 py-3 text-right font-mono" },
            { text: item.spreadBps != null ? formatNumber(item.spreadBps, 1) + " bps" : "--", cls: "px-3 py-3 text-right font-mono" },
            { text: formatNumber(item.midpoint, 4), cls: "px-3 py-3 text-right font-mono" },
            { text: formatTime(item.updatedAt), cls: "px-3 py-3 text-slate-300" }
          ];
          cells.forEach(function (cell) {
            var td = document.createElement("td");
            td.className = cell.cls;
            td.textContent = String(cell.text);
            row.appendChild(td);
          });
          table.appendChild(row);
        });
      }

      function renderCards(items) {
        var wrap = byId("marketsCards");
        if (!wrap) return;
        wrap.innerHTML = "";
        if (!items || items.length === 0) {
          var empty = document.createElement("div");
          empty.className = "rounded-2xl border border-dashed border-slate-800 bg-slate-950/60 px-4 py-6 text-center text-sm text-slate-400";
          empty.textContent = "No markets to display.";
          wrap.appendChild(empty);
          return;
        }
        items.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "grid-card rounded-2xl p-4 fade-in";
          var title = document.createElement("div");
          title.className = "text-sm font-semibold";
          title.textContent = item.title || item.slug || "--";
          var subtitle = document.createElement("div");
          subtitle.className = "mt-1 text-xs text-slate-400";
          subtitle.textContent = item.slug || "--";
          var grid = document.createElement("div");
          grid.className = "mt-3 grid grid-cols-2 gap-2 text-xs";
          var fields = [
            { label: "Volume", value: formatCurrency(item.volume) },
            { label: "Liquidity", value: formatCurrency(item.liquidityUsd) },
            { label: "Spread", value: item.spreadBps != null ? formatNumber(item.spreadBps, 1) + " bps" : "--" },
            { label: "Midpoint", value: formatNumber(item.midpoint, 4) },
            { label: "Updated", value: formatTime(item.updatedAt) }
          ];
          fields.forEach(function (field) {
            var cell = document.createElement("div");
            cell.className = "rounded-xl bg-slate-950/60 p-2 soft-ring";
            var label = document.createElement("div");
            label.className = "text-[10px] uppercase tracking-[0.2em] text-slate-500";
            label.textContent = field.label;
            var value = document.createElement("div");
            value.className = "mt-1 font-mono text-slate-100";
            value.textContent = field.value;
            cell.appendChild(label);
            cell.appendChild(value);
            grid.appendChild(cell);
          });
          card.appendChild(title);
          card.appendChild(subtitle);
          card.appendChild(grid);
          wrap.appendChild(card);
        });
      }

      function renderPagination() {
        var total = state.totalCount || 0;
        var start = total === 0 ? 0 : state.offset + 1;
        var end = Math.min(state.offset + state.limit, total);
        setText("pageLabel", String(Math.floor(state.offset / state.limit) + 1));
        setText("pageRange", start + "-" + end);
        setText("totalCount", String(total));
        setText("resultsMeta", total + " markets");
        var prevBtn = byId("prevPage");
        var nextBtn = byId("nextPage");
        if (prevBtn) prevBtn.disabled = state.offset === 0;
        if (nextBtn) nextBtn.disabled = state.offset + state.limit >= total;
      }

      function setLastUpdated(ts) {
        state.lastUpdated = ts;
        setText("lastUpdated", "Last updated: " + formatTime(ts));
      }

      function renderLoading() {
        renderStatus({ status: "loading" });
        renderTable([]);
        renderCards([]);
      }

      function fetchMarkets() {
        renderLoading();
        var url = buildQuery();
        return fetch(url).then(function (res) {
          return res
            .json()
            .catch(function () { return {}; })
            .then(function (data) {
              return { ok: res.ok, status: res.status, data: data };
            });
        }).then(function (payload) {
          var data = payload.data || {};
          state.totalCount = Number(data.totalCount || 0);
          setLastUpdated(data.updatedAt || null);
          renderStatus(data);
          renderTable(data.items || []);
          renderCards(data.items || []);
          renderPagination();
        }).catch(function () {
          renderStatus({ status: "offline", error: "Unable to fetch markets." });
          renderTable([]);
          renderCards([]);
        });
      }

      function applyFiltersFromUi() {
        var selector = byId("filterSelector");
        var minVolume = byId("filterMinVolume");
        var maxSpread = byId("filterMaxSpread");
        var minLiquidity = byId("filterMinLiquidity");
        var query = byId("filterQuery");
        var sort = byId("sortSelect");
        var pageSize = byId("pageSizeSelect");
        var activeOnly = byId("filterActiveOnly");
        var includeResolved = byId("filterIncludeResolved");
        if (selector) state.selector = selector.value || "top_volume";
        if (sort) state.sort = sort.value || "volume_desc";
        if (pageSize) state.limit = Number(pageSize.value || 25);
        state.minVolume = minVolume ? minVolume.value : "";
        state.maxSpreadBps = maxSpread ? maxSpread.value : "";
        state.minLiquidityUsd = minLiquidity ? minLiquidity.value : "";
        state.q = query ? query.value : "";
        state.activeOnly = activeOnly ? !!activeOnly.checked : true;
        state.includeResolved = includeResolved ? !!includeResolved.checked : false;
        state.offset = 0;
      }

      function setupListeners() {
        var refreshBtn = byId("refreshMarkets");
        if (refreshBtn) refreshBtn.addEventListener("click", function () { fetchMarkets(); });

        var prevBtn = byId("prevPage");
        if (prevBtn) prevBtn.addEventListener("click", function () {
          state.offset = Math.max(0, state.offset - state.limit);
          fetchMarkets();
        });

        var nextBtn = byId("nextPage");
        if (nextBtn) nextBtn.addEventListener("click", function () {
          state.offset = Math.min(state.offset + state.limit, Math.max(0, state.totalCount - state.limit));
          fetchMarkets();
        });

        var filterIds = ["filterSelector", "filterMinVolume", "filterMaxSpread", "filterMinLiquidity", "filterQuery", "sortSelect", "pageSizeSelect", "filterActiveOnly", "filterIncludeResolved"];
        filterIds.forEach(function (id) {
          var el = byId(id);
          if (!el) return;
          el.addEventListener("change", function () {
            applyFiltersFromUi();
            fetchMarkets();
          });
          if (id === "filterQuery") {
            el.addEventListener("keyup", function (event) {
              if (event && event.key === "Enter") {
                applyFiltersFromUi();
                fetchMarkets();
              }
            });
          }
        });

        var autoToggle = byId("autoRefreshToggle");
        if (autoToggle) {
          autoToggle.checked = false;
          autoToggle.addEventListener("change", function () {
            state.autoRefresh = autoToggle.checked;
            if (state.autoRefresh) {
              if (state.timer) clearInterval(state.timer);
              state.timer = setInterval(function () {
                fetchMarkets();
              }, 15000);
            } else if (state.timer) {
              clearInterval(state.timer);
              state.timer = null;
            }
          });
        }
      }

      function init() {
        setText("lastUpdated", "Last updated: --");
        setupListeners();
        fetchMarkets();
      }

      init();
    </script>
  </body>
</html>`;
}

function startLoop(runtime: Runtime) {
  if (state.loopTimer) return;
  state.running = true;
  appendEvent("run", "Paper loop started", { intervalMs: state.intervalMs });
  state.loopTimer = setInterval(async () => {
    if (state.loopInFlight) return;
    state.loopInFlight = true;
    try {
      await runOnce(runtime);
    } catch (err) {
      runtime.log.error("loop run failed", { err: String(err) });
      appendEvent("error", "Loop run failed", { error: String(err) });
    } finally {
      state.loopInFlight = false;
    }
  }, state.intervalMs);
}

function stopLoop() {
  if (state.loopTimer) {
    clearInterval(state.loopTimer);
    state.loopTimer = null;
  }
  state.running = false;
  appendEvent("run", "Paper loop stopped");
}

function setMode(runtime: Runtime, mode: "paper" | "live") {
  if (PAPER_ONLY && mode === "live") {
    return false;
  }
  state.mode = mode;
  if (mode === "paper") {
    runtime.env.PAPER = true;
    runtime.env.LIVE = false;
    runtime.env.DRY_RUN = true;
  } else {
    runtime.env.PAPER = false;
    runtime.env.LIVE = true;
    runtime.env.DRY_RUN = false;
  }
  return true;
}

function setSelector(runtime: Runtime, selector: string, slugs?: string | null) {
  state.selector = selector;
  runtime.env.TARGETS_MODE = selector as "top_volume" | "easy_targets" | "slugs";
  if (selector === "slugs" && slugs) {
    runtime.env.TARGET_SLUGS = slugs;
  }
}

export function startServer(runtime: Runtime, opts: { port?: number } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3001);
  if (runtime.env.PAPER && !runtime.env.LIVE) state.mode = "paper";
  if (runtime.env.LIVE) state.mode = "live";
  state.selector = runtime.env.TARGETS_MODE;
  getUiSettings(runtime);
  if (PAPER_ONLY) {
    setMode(runtime, "paper");
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard(port));
      return;
    }

    if (method === "GET" && url.pathname === "/markets") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderMarketsPage(port));
      return;
    }

    if (method === "GET" && url.pathname === "/api/summary") {
      const summary = await summarize(runtime);
      respondJson(res, 200, summary);
      return;
    }

    if (method === "GET" && url.pathname === "/api/pnl_series") {
      const range = resolvePnlRange(url.searchParams.get("range"));
      const now = Date.now();
      const since = now - range.ms;
      const executions = readJsonl(path.join(DATA_DIR, FILES.executions)).entries;
      const paper = readJsonl(path.join(DATA_DIR, FILES.paper)).entries;
      const series = buildPnlSeries([...executions, ...paper], since, now);
      const stats = computePnlStats(series, since, now);
      respondJson(res, 200, {
        range: range.label,
        updatedAt: new Date(now).toISOString(),
        series: series.map(point => ({ t: new Date(point.t).toISOString(), v: point.value })),
        stats
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/markets/live") {
      const limitRaw = safeNumber(url.searchParams.get("limit"), 25);
      const offsetRaw = safeNumber(url.searchParams.get("offset"), 0);
      const limit = clampNumber(Math.floor(limitRaw), 1, 100);
      const offset = clampNumber(Math.floor(offsetRaw), 0, Number.MAX_SAFE_INTEGER);
      const selectorRaw = safeString(url.searchParams.get("selector"), state.selector);
      const selector =
        selectorRaw === "easy_targets" || selectorRaw === "top_volume" || selectorRaw === "slugs"
          ? selectorRaw
          : state.selector;
      const sort = safeString(url.searchParams.get("sort"), "");
      const minVolumeRaw = safeNumber(url.searchParams.get("min_volume"), NaN);
      const minVolume = Number.isFinite(minVolumeRaw) ? minVolumeRaw : null;
      const maxSpreadRaw = safeNumber(url.searchParams.get("max_spread_bps"), NaN);
      const maxSpreadBps = Number.isFinite(maxSpreadRaw) ? maxSpreadRaw : null;
      const minLiquidityRaw = safeNumber(url.searchParams.get("min_liquidity_usd"), NaN);
      const minLiquidityUsd = Number.isFinite(minLiquidityRaw) ? minLiquidityRaw : null;
      const q = safeString(url.searchParams.get("q"), "");
      const activeOnly = parseBooleanParam(url.searchParams.get("active_only"), true);
      const includeResolved = parseBooleanParam(url.searchParams.get("include_resolved"), false);
      const payload = await getLiveMarketsCached(runtime, {
        limit,
        offset,
        selector,
        sort,
        minVolume,
        maxSpreadBps,
        minLiquidityUsd,
        q,
        activeOnly,
        includeResolved
      });
      const statusCode =
        payload.status === "rate_limited" ? 429 : payload.status === "offline" ? 503 : 200;
      respondJson(res, statusCode, payload);
      return;
    }

    if (method === "GET" && url.pathname === "/api/markets") {
      const books = readJsonl(path.join(DATA_DIR, FILES.books)).entries;
      const items = buildMarketSnapshots(books);
      respondJson(res, 200, { items, updatedAt: new Date().toISOString() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/positions") {
      const books = readJsonl(path.join(DATA_DIR, FILES.books)).entries;
      const orders = readJsonl(path.join(DATA_DIR, FILES.orders)).entries;
      const marketSnapshots = buildMarketSnapshots(books);
      const marketIndex = new Map<string, MarketSnapshot>();
      marketSnapshots.forEach(item => marketIndex.set(item.id, item));
      const positions = extractPositions(orders, marketIndex);
      const fills = extractFills(orders, 12);
      respondJson(res, 200, { positions, fills, updatedAt: new Date().toISOString() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/analyses") {
      const analyses = readJsonl(path.join(DATA_DIR, FILES.analyses)).entries;
      const items = extractAnalyses(analyses, 8);
      respondJson(res, 200, { items, updatedAt: new Date().toISOString() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/activity") {
      const items = buildActivityFeed(DATA_DIR, 30);
      respondJson(res, 200, { items, updatedAt: new Date().toISOString() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/action") {
      try {
        const body = await readRequestBody(req);
        const parsed = JSON.parse(body) as ActionRequest;
        if (parsed.action === "run_once") {
          try {
            await runOnce(runtime);
            appendEvent("run", "Manual run_once triggered");
          } catch (err) {
            runtime.log.error("run once failed", { err: String(err) });
            appendEvent("error", "run_once failed", { error: String(err) });
          }
          respondJson(res, 200, { ok: true });
          return;
        }
        if (parsed.action === "run_ticks") {
          const ticks = parsed.ticks == null ? 1 : Number(parsed.ticks);
          const intervalMs = parsed.intervalMs == null ? 0 : Number(parsed.intervalMs);
          if (ticks === 0) {
            if (Number.isFinite(intervalMs) && intervalMs >= 0) {
              state.intervalMs = Math.max(0, Math.floor(intervalMs));
            }
            if (state.loopTimer) {
              stopLoop();
            }
            startLoop(runtime);
            respondJson(res, 200, { ok: true, running: true, intervalMs: state.intervalMs });
            return;
          }
          if (state.loopTimer) {
            stopLoop();
          }
          await runTicks(runtime, Number.isFinite(ticks) ? ticks : 1, Number.isFinite(intervalMs) ? intervalMs : 0);
          appendEvent("run", "run_ticks executed", { ticks, intervalMs });
          respondJson(res, 200, { ok: true, ran: ticks });
          return;
        }
        if (parsed.action === "stop") {
          stopLoop();
          respondJson(res, 200, { ok: true, running: false });
          return;
        }
        if (parsed.action === "reset") {
          clearJsonlFiles(DATA_DIR);
          appendEvent("reset", "Data directory cleared");
          respondJson(res, 200, { ok: true, cleared: true });
          return;
        }
        if (parsed.action === "set_mode") {
          const modeValue = String(parsed.value || "").toLowerCase();
          if (modeValue === "paper" || modeValue === "live") {
            const ok = setMode(runtime, modeValue);
            if (ok) {
              appendEvent("config", "Mode updated", { mode: modeValue });
            } else {
              respondJson(res, 400, { ok: false, error: "Live trading disabled (paper-only)" });
              return;
            }
          }
          respondJson(res, 200, { ok: true, mode: state.mode });
          return;
        }
        if (parsed.action === "set_selector") {
          const selectorValue = String(parsed.value || "").toLowerCase();
          if (selectorValue) {
            setSelector(runtime, selectorValue, parsed.slugs ?? null);
            appendEvent("config", "Selector updated", { selector: selectorValue, slugs: parsed.slugs ?? null });
          }
          respondJson(res, 200, { ok: true, selector: state.selector });
          return;
        }
        if (parsed.action === "close_all") {
          if (!runtime.env.PAPER) {
            respondJson(res, 400, { ok: false, error: "close_all only supported in paper mode" });
            return;
          }
          const ordersPath = path.join(DATA_DIR, FILES.orders);
          if (fs.existsSync(ordersPath)) fs.rmSync(ordersPath);
          appendEvent("trade", "All paper positions closed");
          respondJson(res, 200, { ok: true, closed: true });
          return;
        }
        if (parsed.action === "set_risk_params") {
          if (state.mode !== "paper" || !runtime.env.PAPER) {
            respondJson(res, 400, { ok: false, error: "Risk params can only be updated in paper mode" });
            return;
          }
          const settings = persistUiSettings(runtime, {
            kellyFraction: parsed.kellyFraction == null ? undefined : safeNumber(parsed.kellyFraction, 0),
            maxPosUsd: parsed.maxPosUsd == null ? undefined : safeNumber(parsed.maxPosUsd, 0),
            maxDailyLossUsd:
              parsed.maxDailyLossUsd == null ? undefined : safeNumber(parsed.maxDailyLossUsd, 0),
            maxPositions:
              parsed.maxPositions == null ? undefined : safeNumber(parsed.maxPositions, 0),
            spreadBps: parsed.spreadBps == null ? undefined : safeNumber(parsed.spreadBps, 0),
            minDepthUsd: parsed.minDepthUsd == null ? undefined : safeNumber(parsed.minDepthUsd, 0)
          });
          appendEvent("config", "Risk params updated", { ...settings });
          respondJson(res, 200, { ok: true, settings });
          return;
        }
        respondJson(res, 400, { ok: false, error: "Unknown action" });
        return;
      } catch (err) {
        respondJson(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.listen(port, () => {
    runtime.log.info("server started", { port });
  });

  return server;
}
