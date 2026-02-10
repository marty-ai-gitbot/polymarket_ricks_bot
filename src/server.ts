import fs from "node:fs";
import path from "node:path";

import http from "node:http";
import { URL } from "node:url";

import type { Runtime } from "./runtime.js";
import { runOnce } from "./bot.js";

type Summary = {
  booksCount: number;
  ordersCount: number;
  marketsCount: number;
  lastRunTime: string | null;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return { lines: [] as string[], entries: [] as unknown[] };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
  const entries: unknown[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ parse_error: true, raw: line });
    }
  }
  return { lines, entries };
}

function tailLines(lines: string[], count: number) {
  if (count <= 0) return [];
  return lines.slice(Math.max(0, lines.length - count));
}

function summarize(booksEntries: unknown[], ordersEntries: unknown[]): Summary {
  const marketIds = new Set<string>();
  const times: number[] = [];

  for (const entry of booksEntries) {
    if (entry && typeof entry === "object") {
      const market = (entry as { market?: { id?: string } }).market;
      if (market?.id) marketIds.add(String(market.id));
      const t = (entry as { t?: string }).t;
      if (t) {
        const parsed = Date.parse(t);
        if (!Number.isNaN(parsed)) times.push(parsed);
      }
    }
  }

  for (const entry of ordersEntries) {
    if (entry && typeof entry === "object") {
      const t = (entry as { t?: string }).t;
      if (t) {
        const parsed = Date.parse(t);
        if (!Number.isNaN(parsed)) times.push(parsed);
      }
    }
  }

  const lastRunTime =
    times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;

  return {
    booksCount: booksEntries.length,
    ordersCount: ordersEntries.length,
    marketsCount: marketIds.size,
    lastRunTime
  };
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

export function startServer(runtime: Runtime, opts: { port?: number } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const dataDir = path.resolve("./data");
  const booksPath = path.join(dataDir, "books.jsonl");
  const ordersPath = path.join(dataDir, "orders.jsonl");

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Polymarket Rick's Bot</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; }
      a { color: #0b5fff; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .actions { display: flex; gap: 12px; margin: 12px 0; }
      button { padding: 8px 12px; }
    </style>
  </head>
  <body>
    <h1>Polymarket Rick's Bot</h1>
    <p>Local testing UI for paper-only runs.</p>
    <div class="actions">
      <a href="/testing">Go to testing dashboard</a>
    </div>
    <div class="actions">
      <form method="post" action="/run/once">
        <button type="submit">Run one tick</button>
      </form>
      <form method="post" action="/reset">
        <button type="submit">Reset local data</button>
      </form>
    </div>
  </body>
</html>`);
      return;
    }

    if (method === "GET" && url.pathname === "/testing") {
      const n = Number.parseInt(String(url.searchParams.get("n") ?? "20"), 10);
      const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 20;

      const books = readJsonl(booksPath);
      const orders = readJsonl(ordersPath);
      const summary = summarize(books.entries, orders.entries);

      const booksTail = tailLines(books.lines, limit).map(escapeHtml).join("\n");
      const ordersTail = tailLines(orders.lines, limit).map(escapeHtml).join("\n");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Testing Dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; }
      a { color: #0b5fff; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .actions { display: flex; gap: 12px; margin: 12px 0; }
      button { padding: 8px 12px; }
      pre { background: #f6f8fa; padding: 12px; border-radius: 6px; max-height: 300px; overflow: auto; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .summary { background: #fbfbfd; border: 1px solid #e5e7eb; padding: 12px; border-radius: 8px; }
      .summary strong { display: inline-block; min-width: 140px; }
    </style>
  </head>
  <body>
    <h1>Testing Dashboard</h1>
    <p><a href="/">Back to landing</a></p>
    <div class="actions">
      <form method="post" action="/run/once">
        <button type="submit">Run one tick</button>
      </form>
      <form method="post" action="/reset">
        <button type="submit">Reset local data</button>
      </form>
    </div>
    <div class="summary">
      <div><strong>Books entries:</strong> ${summary.booksCount}</div>
      <div><strong>Orders entries:</strong> ${summary.ordersCount}</div>
      <div><strong>Markets seen:</strong> ${summary.marketsCount}</div>
      <div><strong>Last run time:</strong> ${summary.lastRunTime ?? "never"}</div>
    </div>
    <h2>Last ${limit} lines: books.jsonl</h2>
    <pre>${booksTail || "(empty)"}</pre>
    <h2>Last ${limit} lines: orders.jsonl</h2>
    <pre>${ordersTail || "(empty)"}</pre>
  </body>
</html>`);
      return;
    }

    if (method === "POST" && url.pathname === "/run/once") {
      try {
        await runOnce(runtime);
      } catch (err) {
        runtime.log.error("run once failed", { err: String(err) });
      }
      res.writeHead(303, { Location: "/testing" });
      res.end();
      return;
    }

    if (method === "POST" && url.pathname === "/reset") {
      clearJsonlFiles(dataDir);
      res.writeHead(303, { Location: "/testing" });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.listen(port, () => {
    runtime.log.info("server started", { port });
  });

  return server;
}
