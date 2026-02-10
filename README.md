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

Open `http://localhost:3000` and use the dashboard to run a tick, view the last entries from `data/books.jsonl` and `data/orders.jsonl`, and reset local data.

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

All outputs are written under `data/` and visible in the testing dashboard at `http://localhost:3000/testing`.
