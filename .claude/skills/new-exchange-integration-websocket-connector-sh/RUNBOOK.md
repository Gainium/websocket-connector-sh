# websocket-connector-sh — new exchange runbook

Canonical source: `new-exchange-integration` (private `skills` repo). This
is a scoped excerpt — see [SKILL.md](SKILL.md) for the narrative version.

## Where this sits

Repo **2 of the public pipeline** (exchange-connector-sh →
**websocket-connector-sh** → app-sh → paper-trading-sh → backtester →
main-dash-sh → content → docker-sh). Independent of `exchange-connector-sh`
in terms of code (this is a separate adapter surface, not built on top of
it), but coordinate the symbol/exchange-id strings so they match exactly —
see the mismatch warning below. `app-sh`'s exchange-info cron and paper
trading both depend on this repo's `ExchangeEnum` + `mapPaperToReal`.

## Checklist

```
[ ] price/<name>.ts             (price/candle → Redis channels)
[ ] price/service.ts            (ConnectorType + createConnector)
[ ] priceConnector.ts           (worker init/route/stop)
[ ] userStream.ts               (order/balance events)
[ ] utils/exchange.ts           (getAllExchangeInfo branch + symbol maps, if no REST "all symbols" endpoint)
[ ] utils/common.ts             (ExchangeEnum members + paper twins + mapPaperToReal)
[ ] CHANGELOG + version bump
```

## Verify before calling it done

- Subscribe to the Redis channels this connector publishes and confirm
  ticks/candles actually arrive with the exact expected channel-name
  strings — a silent typo here has no error path.
- The `exchange` id and normalized `symbol` string this repo emits on the
  live-write path must be byte-identical to what `exchange-connector-sh`'s
  `getCandles` returns on the backfill path — a mismatch splits history
  into two disjoint series downstream (surfaces as a backtester bug, isn't
  one).
- If self-hosted matters for this exchange, add it to
  `docker-sh`'s `PRICE_CONNECTOR_EXCHANGES` default and README — otherwise
  this connector never starts on a self-hosted box.
