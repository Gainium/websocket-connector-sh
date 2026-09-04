---
name: new-exchange-integration-websocket-connector-sh
description: This repo's slice of adding a brand-new exchange to Gainium — the price/candle and private user (order/balance) streams, republished onto Gainium's internal Redis channel contract. Use when scoping or implementing a new-exchange PR in websocket-connector-sh.
---

# New exchange integration — websocket-connector-sh's part

Canonical source: `new-exchange-integration` in Gainium's internal `skills`
repo (private — this file is a scoped copy synced from there; edit the
source, not this copy, if it needs updating).

## Global objective

Gainium supports trading on multiple exchanges through a common internal
`Exchange` interface and a common streaming contract — one adapter (in
`exchange-connector-sh`) plus one set of stream connectors (here) per
exchange, so the rest of the platform never has to know which exchange it's
talking to. This repo owns the live side: price/candle ticks and private
order/balance events, normalized onto the same Redis channels for every
exchange.

## This repo's part

- **`src/price/<name>.ts`** — a connector subscribing to the exchange's
  price/candle WS and republishing onto the canonical Redis channels
  `trade@{symbol}@{exchange}` and `{symbol}@{exchange}@{interval}Candle`.
  **These channel names are a hard contract** — consumers elsewhere in the
  platform subscribe by these exact strings; a typo means silently no
  prices/fills, with no error anywhere.
- **`src/price/service.ts`** — import the new connector, add it to the
  `ConnectorType` union, add the `createConnector` branch.
- **`src/priceConnector.ts`** — worker init/route/stop plumbing, mirroring
  the existing per-exchange pattern.
- **`src/userStream.ts`** — handle the exchange's private user-stream (order
  updates, balances), emit normalized order/balance events.
- **`src/utils/exchange.ts`** — if the exchange has no REST "all symbols"
  endpoint, add a branch in `getAllExchangeInfo` that builds symbols from
  the symbol maps instead.
- **`src/utils/common.ts`** — add the `ExchangeEnum` members (this repo is
  one of several places the enum is independently declared) **and** the
  `paper<Name>` twins, plus the `mapPaperToReal` cases mapping each paper
  variant back to its real counterpart.

> **Self-hosted gating — `PRICE_CONNECTOR_EXCHANGES`.** The price connector
> only starts a worker for an exchange if it's in the
> `PRICE_CONNECTOR_EXCHANGES` env list read in `priceConnector.ts` (empty
> list = all exchanges on). Self-hosted deployments use an explicit
> allowlist instead — see `docker-sh`'s `.env.sample` default and README.
> Miss this and self-hosted users get no prices/candles for the new
> exchange even though the code is correct.

## Sister repos

All public, same repo family as this one:

- **exchange-connector-sh** — the adapter this repo's price/candle work
  should stay symbol-for-symbol consistent with (same `exchange` id, same
  normalized symbol string on both sides — a mismatch here is invisible
  until someone runs a backtest and gets half a history).
- **app-sh** — the bot engine that consumes the order/balance events this
  repo emits, plus the exchange-info cron.
- **paper-trading-sh** — consumes the same enum + paper-mapping this repo
  defines.
- **main-dash-sh** — the dashboard's chart/candle loading ultimately reads
  through this repo's price data (via main-app).
- **backtester** — historical backtests read through a separate archive
  path, but depend on this repo's live-write path feeding it correctly.
- **content** — the "connect via API keys" guide.
- **docker-sh** — the self-hosted release bundle; also owns the
  `PRICE_CONNECTOR_EXCHANGES` default this repo reads.

Gainium's cloud SaaS wires a few more pieces on top of this stack
(paid-plan gating, an internal monitoring/admin layer, marketing pages) —
not part of the self-hosted deployment, not this repo's concern.
