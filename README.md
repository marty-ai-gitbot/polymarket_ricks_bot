# polymarket_ricks_bot

Sample repo scaffold for a future Polymarket bot.

## What this is
- Minimal Node + TypeScript project
- Placeholder structure for data fetching + strategy + execution

## Setup
```bash
pnpm install
pnpm dev
```

## Env
Copy `.env.example` to `.env` and fill values.

## Testing UI
Paper-only local testing dashboard and CLI runner.

```bash
pnpm bot:ui
```

Open `http://localhost:3001` and use the dashboard to run a tick, view the last entries from `data/books.jsonl` and `data/orders.jsonl`, and reset local data.

### CLI one-shot
```bash
pnpm bot:once
pnpm bot:ticks
```

Override tick count and interval as needed:
```bash
pnpm dev -- --ticks 10 --interval-ms 2000
```

### CLI flags
Run one tick with a selector and paper mode:
```bash
pnpm dev -- --once --mode paper --selector top_volume
```

Run multiple ticks with a custom interval:
```bash
pnpm dev -- --ticks 3 --interval-ms 1500 --selector easy_targets
```

Run the server on a custom port:
```bash
pnpm dev -- --port 4001
```

All outputs are written under `data/` and visible in the testing dashboard at `http://localhost:3001`.

## Risk controls in UI
The dashboard includes a paper-only risk control panel for adjusting guardrails without touching `.env`.

- Controls: Kelly fraction (0.0–1.0), max position size (USD or % bankroll), max daily loss, max concurrent positions, spread threshold (bps), and minimum depth (USD).
- Display: effective caps (Kelly cap, effective max position, daily loss %, max positions) plus tight-cap warning badges.
- Persistence: settings are stored in `data/ui_settings.json` and loaded on server start.
- API: `POST /api/action` with `{ "action": "set_risk_params", "kellyFraction", "maxPosUsd", "maxDailyLossUsd", "maxPositions", "spreadBps", "minDepthUsd" }`.

## UI tour
The dashboard is a full trading + ops control center with every major system surfaced:

- Overview/Hero: mode, selector, running state, markets analyzed today, open positions, total PnL, and LLM burn with remaining budgets.
- Strategy: Kelly sizing inputs, bankroll, risk caps, and selector spread/depth filters.
- Markets: selected market table with volume, spread, midpoint, and last update, plus a refresh button.
- Positions & Orders: open positions table and paper fills/executions feed, with a paper-only close-all control.
- LLM / Analyst: last analyses with probability, confidence, rationale previews, token usage, and per-analysis cost.
- Activity: unified event stream sourced from `data/*.jsonl`.
- System Health: Gamma/CLOB/OpenAI connectivity, uptime, memory usage, and data file counts.
- Controls: start/stop loop, run once, run ticks, switch mode/selector/interval, and reset data.
