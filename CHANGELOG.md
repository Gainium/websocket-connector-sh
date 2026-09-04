# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.15.0] - 2026-09-04

### Added

- **WhiteBit streams (spot `whitebit` + USDⓈ-M perps `whitebitUsdm`) — draft.** WhiteBit ships no npm SDK, so both the public and the private side are hand-rolled raw-`ws` clients on the Hyperliquid pattern, sharing one JSON-RPC client (`src/utils/whitebitWsClient.ts`) that owns the connection, the ~50s `ping` the venue requires (it drops connections idle for 60s), reconnect backoff and — new to this repo — request/response correlation by JSON-RPC `id`, which `authorize` is the only call to need. `src/price/whitebit.ts` republishes `trades_update` and `candles_update` through the existing `cbWs`/`cbWsTrade`/`getCandleRoomName` base-class methods, so the Redis channel names are unchanged. One connector class serves both variants: the product family is readable off the market name (`BTC_USDT` vs `BTC_PERP`). `userStream.ts` gains the private branch — the WS token is minted by a signed `POST /api/v4/profile/websocket_token` (HMAC-SHA512), never over the socket, and `balanceSpot`/`ordersExecuted`/`positionsMargin` are normalized into the existing `UserDataStreamEvent` union. `getAllExchangeInfo` gets a bespoke WhiteBit REST branch (Kraken pattern), and the enum gains `whitebit`/`whitebitUsdm` plus their paper twins.
- Two WhiteBit column/unit conventions are pinned by tests because a copy from any other venue here is silently wrong: `candles_update` sends **open and close BEFORE high and low**, and `trades_update`'s `time` is a **float number of seconds** while the candle channel's is integer seconds. `ordersExecuted_update`'s `side` is numeric with **1 = sell, 2 = buy** — the opposite polarity to Kraken Futures' numeric `direction`, the only other numeric side in `userStream.ts`. Tests: `test/whitebitCandleParsing.test.ts`, `test/whitebitUserStreamAuth.test.ts`.
- Known gaps, marked in-tree: `// TODO §3.5` (the interval table covers every documented WhiteBit interval and every `ExchangeIntervals` member, but the full accepted set was never confirmed live — unmapped intervals are skipped, not guessed), `// TODO §3.6` (the REST token's lifetime/reuse is unconfirmed, so a fresh token is minted on every connect and reconnect) and one open question beyond spec §3: whether a single connection can hold more than one `candles_subscribe` (one socket per candle room is the safe reading). The four unconfirmed minor private channels (margin balance, pending orders, deals, borrows) are deliberately not subscribed. Nothing here is live until `websocket-connector` bumps this repo as `core/` and a WhiteBit account exists, so no existing exchange's behaviour changes.

## [1.14.11] - 2026-09-03

### Fixed

- **Kraken spot accounts never received a live balance update.** The private `balances` channel on Kraken WebSocket v2 delivers `{channel, type, data:[…]}`; `prepareKrakenBalanceMsg` only understood a bare array, the futures `holding` object and `flex_futures`, so every spot message fell through, returned undefined and nothing was published — dashboards showed the 00:45 daily REST snapshot all day (2026-09-03: 24 Kraken spot accounts, 0 balance rows updated in 30 min while every other venue was fresh; a user saw 13.5 ETH with 1.53 on Kraken). Spot v2 snapshots and updates are now converted with `free = balance` and **no `locked` field**: Kraken reports the total with no hold figure, so emitting `locked:'0'` would overstate "available" on every event; main-app ≥ 2.88.4 leaves `locked` untouched when the field is absent. Futures messages are unchanged. Tests: `test/krakenSpotBalances.test.ts`.

## [1.14.10] - 2026-08-30

### Fixed

- The credential fingerprint (1.14.9) is now whitespace-insensitive. The binance branch mutates `api.secret` in place (PRIVATE-KEY space→newline normalization) before the exception handler arms the breaker, so the armed fingerprint never matched the raw secret of the next re-request and the "credentials changed" bypass re-lifted the cooldown every time — a circuit-broken `-1193` room became a ~1/sec reject loop (observed on the 2026-08-30 deploy, 149 rejects in 3 minutes; pinned by test).

## [1.14.9] - 2026-08-30

### Fixed

- **A legacy (HMAC/RSA) Binance spot key is now circuit-broken like any other auth reject instead of retrying forever.** Binance spot dropped the legacy listenKey user stream, so those keys can never subscribe — but the old path just threw per attempt, and the bots re-request rooms every few minutes with no backoff: 123 accounts produced ~3.5k error lines in 100 minutes on 2026-08-30, had no user stream at all (every fill on them was detected only by the reconcile sweep, minutes late), and the user was never told. The path now arms the same escalating cooldown (30min → 24h) as a `-1193`/`-2015` reject and emits the `userStreamAuthReject` notice with the precise fix (create an Ed25519 key), so main-app raises the daily "Realtime feed unavailable" bot-message.
- **A replaced key no longer waits out the cooldown its predecessor earned.** Bot-driven rooms are keyed by the account uuid, which survives a key swap, so the auth-rejection gate blocked the *fixed* credential for up to 24h (the "regenerated key hashes to a different id" assumption only holds for hash-keyed rooms). The breaker now records a fingerprint of the rejected credential and the gate lifts the cooldown the moment a request carries different key material.

### Added

- `userStreamAuthReject` now carries `exchangeUUID` (the room id) and `kind` (`authReject` | `legacyKey`), and a circuit-broken room that delivers a genuine account event again emits `userStreamAuthRecovered {exchangeUUID}` — so main-app can keep a per-account dead-stream record for the admin user-stream-health page and the fill-failsafe escalation (self-healing an auth-dead stream is pointless; those accounts should be informed, not restarted).

## [1.14.8] - 2026-08-29

### Fixed

- Kraken and Binance user streams now tell an account's bots to reconcile after a websocket reconnect, the way the bybit and bitget handlers already did. Both `reconnected` handlers only bumped the flap counter, so an in-place SDK reconnect published nothing on `userStreamInfo{exchangeUUID}` and the bots never re-checked their orders — any `executions` / `executionReport` message the venue emitted while the socket was down was lost until the next *process* restart, in practice the nightly one. A Kraken ETH/EUR safety order filled at 16:15 UTC on 2026-08-28 was booked 15h38m later for exactly this reason; that account's socket had reconnected at 15:53, 21 minutes before the fill. Kraken alone reconnects ~1,088 times a day across the fleet, so this was a wide hole. The signal is scoped to the one account's room, so it wakes a handful of bots rather than the fleet.

## [1.14.7] - 2026-08-26

### Fixed

- Coinbase now reports partial fills. Coinbase Advanced Trade has no PARTIALLY_FILLED order status: a resting order that has taken some size stays `OPEN` and reports the progress in `cumulative_quantity`, and only the terminal states change `status`. The mapper collapsed `OPEN` to `NEW` unconditionally, so this venue never emitted a single PARTIALLY_FILLED report — the bybit and bitget mappers alongside it both make the distinction — and a consumer that books partial fills never heard about the executed part. Terminal states are untouched, and a non-numeric cumulative quantity still maps to `NEW`.

## [1.14.6] - 2026-08-22

### Fixed

- **The Kraken Futures `open_orders` feed reported a partial execution as FILLED.** On that feed `order.qty` is the quantity still open, not the size placed; the mapping read it as the total and compared `filled >= qty`, so a 16-lot order with 11 executed arrived as `{qty: 5, filled: 11}` → FILLED at 11. The bot engine, told an order had "fully" filled 5 short of what it placed, sent a market remainder for the 5 — and the original order then filled to 16 on its own. The venue held 21, the deal booked 11, and the extra 5 sat on the exchange with no take-profit and no stop-loss. Observed live on 2026-08-22; 40 such duplicate remainders across 26 accounts in the two weeks before. Status now comes from what remains open (`FILLED` only at `qty == 0`) and the reported quantity is the original size (`filled + qty`), so `executedQty < origQty` means what the consumer thinks it means. The `fills` feed had the same defect and was fixed on 2026-08-07 (`krakenFillTotals`); this is the other half. Pinned by `src/utils/krakenOpenOrders.spec.ts`.
- `open_orders` removals with `reason: 'full_fill'` are no longer relayed as CANCELED. Kraken removes a fully filled order from the book with `is_cancel: true`; the fill itself arrives on the `fills` feed with quantity and price, and a CANCELED on top of it is the exact shape that has marked filled orders dead before.

## [Unreleased]

### Added

- The Kraken Futures balance event now carries `venueAvailable` — Kraken's own per-currency "available" figure — alongside `free`/`locked`. Optional and additive: producers with no such figure omit it and consumers that ignore it are unaffected. It exists because `free`/`locked` cannot describe a pooled cross-collateral account: on a flex account every currency margins every contract, so `free` is the wallet quantity and `locked` is 0, and nothing else reports continuously how much margin the venue has actually committed. `free - venueAvailable` is that number, which makes a position the engine is not tracking visible as committed margin with no deal behind it — otherwise it stays invisible until an order is rejected. Deliberately not folded back into `locked`, which has one meaning shared with the REST writer that cannot produce this.

### Fixed

- **The Kraken Futures balance event derived a `locked` amount that is not a reservation.** The flex-account branch of `prepareKrakenBalanceMsg` emitted `free: available, locked: quantity - available` from the per-currency summary. `available` is absent from Kraken's own REST schema for a flex currency summary (`{quantity, value, collateral}`) — it is a top-level account field — and was read here through `as any`, so the mapping was never type-checked; in practice the resulting `locked` bore no relation to the account's open exposure, and was non-zero even on accounts with no open positions. Worse, it contradicted the other writer of the same `balances` doc: the REST path reports the wallet quantity as fully free (`locked: 0`), so a Kraken account's stored balance meant whichever write landed last. main-app's not-enough-balance latch reads that doc, and could jam a bot into `error` permanently, because the cached `free` never rose back above the required amount. A flex account pools every collateral currency into one cross-margin pool, so there is no per-currency reservation to report at all; the event now carries the wallet quantity with `locked: 0`, matching the REST writer. The figure the venue actually enforces is `flex.availableMargin`, which main-app reads through `getMarginAvailableUsd`. Existing docs self-heal on the next balance event — no migration needed.

- **The user-stream auth-rejection breaker retried a permanently-dead key every 30min forever, making it the largest single source of error lines in the user-stream log (bug #289).** The breaker itself was correct — it arms on first sight, closes the client, publishes `userStreamAuthReject` so main-app warns the user, and schedules one self-heal retry so a key fixed *in place* (Kraken's "WebSocket interface" permission enabled, an egress IP whitelisted) recovers without a bot restart. But the retry delay was a flat 30min, so a key that is genuinely revoked reproduced its `Kraken exception … Failed to subscribe to authenticated feed` + `circuit-broken for 1800s` pair 48x a day, per account, indefinitely; the reported alert was ~20 accounts doing exactly that with no service fault behind it. The cooldown now escalates per consecutive rejection — 30min → 1h → 2h → 4h → 8h → 16h → 24h, capped, overridable via `USER_STREAM_AUTH_COOLDOWN_MAX_MS` — collapsing a dead key from 48 cycles a day to 1 (~95% fewer lines) while never giving up on it. Recovery is unaffected: the ladder resets the moment the account delivers a genuine order/balance event, a rejection arriving long after the previous one starts over at 30min rather than inheriting a multi-hour step, and callers re-requesting a room still recover it the moment the gate lapses, independently of the timer. The Binance (-2015/-2014/-2008/401) and Kraken breakers now share one `armAuthCooldown`/`scheduleAuthSelfHeal` path, and both log lines carry the strike number so the escalation is visible.
- **A stream could be reopened forever for a credential the user had deleted.** The self-heal retry was an untracked `setTimeout`. Since arming the breaker deletes the room's subscriber count and user entry, a later unsubscribe for that room hit `closeStreamCallback`'s "has no subscribers" branch and did nothing — the orphan timer then reopened the stream after the cooldown, and re-armed on the next rejection, with no live connection behind it. Retries are now tracked per room and cancelled when the room is torn down (both the circuit-broken and the ordinary last-unsubscribe path), which also drops the retained subscribe payload and the breaker's per-room bookkeeping. The cooldown *gate* is deliberately kept on teardown so a close can't be used to bypass the breaker; it is dropped in `openStreamCallback` once it genuinely lapses. Covered by `test/userStreamAuthBackoff.test.ts`.
- **A failed Hyperliquid ticker subscription spun a zero-delay restart loop that starved the entire price worker's event loop (bug #218).** `initHyperliquidWS()`'s `catch` called `hyperliquidRestartCb()` directly, which calls `initHyperliquidWS()` again — no delay, no backoff, no in-flight guard. While Hyperliquid rate-limits our IP the `allMids` subscribe fails persistently, so the two functions called each other in a tight loop; and because each iteration tears down and rebuilds every `WebSocketTransport`, the loop kept re-tripping the per-IP connection limit that caused it. Field data from a 25h run: 244k `allMids subscription failed` lines (peak 2 304/s, ~90% of all price-connector error output, three 55MB rotated logs inside 4-minute windows), 297k abnormal socket closes, 231% CPU / 1.3GB RSS. Critically the loop re-enters through *already-settled* promises, so every iteration is a microtask and the macrotask queue never gets a turn: a driven A/B measured **578 149 subscribe attempts and 1 156 296 transports in 100s, with a 1s `setInterval` firing 0 times** — i.e. `CommonConnector.watchdogFn` and every other exchange's timers were stopped too, which is the real source of the collateral `bitgetUsdm` stall crashes seen in the same runs. All full restarts now go through a single-flight `scheduleHyperliquidRestart()`: concurrent requests coalesce into the pending restart, and the delay is `backoff − elapsed` (30s, doubling to a 5min cap, reset to base after 10min quiet) so a restart following a healthy period still fires **immediately** and only consecutive failures are paced. Same A/B after the fix: **4 attempts / 6 transports in 100s, 99 of 100 timer ticks**.
- **A Hyperliquid stall crashed the whole price worker, taking every other exchange's feeds with it.** 1.14.0 added the `handleStall` isolation hook so a stalled exchange restarts only its own streams; Kraken and Bybit adopted it but `HyperliquidConnector` did not, so a stall still reached the `throw` in `CommonConnector.watchdogFn` — and a throw inside a `setInterval` callback is an uncaught exception that terminates the process. `HyperliquidConnector` now overrides `handleStall` for all three stall kinds (a full Hyperliquid restart rebuilds ticker and candle clients alike), routed through the same paced scheduler. `CommonConnector` still escalates to the full-worker restart after `maxTargetedRestarts`, so a genuinely dead worker is still replaced — verified: the first two stalls are handled in place, the third still throws.
- The per-IP connection ceiling is now the named `maxHyperliquidConnections` constant, overridable via `HYPERLIQUID_MAX_WS_CONNECTIONS`, and the stale "≤10 connections" comment in `getCandleClient` is corrected. The default is unchanged — Hyperliquid documents 10 simultaneous WS connections per IP, so the derived candle-client cap stays at 8. `stop()` now also clears the restart timer.

## [1.14.0] - 2026-07-30

### Added

- OKX Europe X-Perp ticker feed: a dedicated, isolated WS client subscribed only to xperp instruments publishes them on the canonical `trade@{pair}@okxLinear` channels (expiry suffix stripped to the `BTC-USD_UM_XPERP` pair id). Optional `OKX_EU_ONLY` mode for EU-only deployments. Contributed by community member discord2020 (forum topic 4925).
- X-Perp candle streams: candle subscriptions resolve the instFamily to the live expiry-suffixed instId (the WS channel rejects the bare family id).

## [1.13.7] - 2026-07-30

### Fixed

- **Price connector's restart announcement never left the process — every restart silently orphaned every candle subscription platform-wide.** `init()` published `{restart:'priceConnector'}` on `serviceLog` with a bare `this.redis?.publish(...)`, but `initRedis()` is fire-and-forget from the constructor and `index.price` calls `init()` synchronously after `new Connector()`, so `this.redis` was *always* still null and `RedisWrapper.publish` returned early without sending. Since candle subscriptions live only in this process's memory, consumers were never told to re-request them: after the nightly 02:00 exit the connector held ~0 candle subscriptions while ~13.5k Redis candle channels still had subscribers. Measured on prod 2026-07-30, 3.5h after the restart: candle publishes came from `bitget` only; `binance` (6.7k subscribed channels), `bybit`, `okx`, `kraken`, `kucoin` and `hyperliquid` were all silent, while `trade@` tickers were healthy. Bug #162's Hyperliquid candle-blindness was one symptom of this. `announceBoot()` now awaits the Redis client before publishing.
- **Restart recovery no longer depends on a single un-acknowledged pub/sub message.** The connector also publishes a repeating `{priceConnectorAlive:{bootId,role}}` beacon on `serviceLog` every 60s, carrying a per-instance boot id (also added to the one-shot broadcast so consumers can dedupe the two). Consumers on main-app-sh ≥1.37.11 re-request their candle subscriptions when the id changes, so a broadcast lost to a flapping subscription self-heals within a beacon interval instead of persisting until the consumer's own next restart. Deliberately omits `.restart` so pre-beacon consumers ignore it rather than re-requesting every 60s. `stop()` clears the timer so an in-process rebuild doesn't stack beacons.

## [1.13.6] - 2026-07-29

### Added

- **Kraken auth-rejection circuit-breaker now tells the user, not just the log.** When the breaker (v1.13.5) trips it additionally publishes a `userStreamAuthReject` event `{exchange, userId, reason}` on the existing `serviceLog` Redis channel — the same channel main-app already consumes for `userStreamFlap` — where main-app ≥2.71.20 turns it into a per-user bot-message warning naming the missing "WebSocket interface" permission (or the revoked-key case). Emit-only: a publish failure never affects the breaker. Older main-app versions ignore the unknown event.

## [1.13.5] - 2026-07-29

### Fixed

- **Kraken auth-feed subscribe failures retried forever, silently degrading fill delivery (issue #167).** Two shapes, both deterministic key problems the retry loop can never fix: `EGeneral:Permission denied` — the WS-token REST call rejected because the API key lacks Kraken's "WebSocket interface" permission (REST verify passes, so the connection looks healthy and nothing upstream ever stops re-requesting the stream) — and `Failed to subscribe to authenticated feed` on Kraken Futures (revoked/disabled keys on status=false connections, where the client library reconnects forever). Affected users got no realtime order updates and fell back to reconcile-sweep-only fills, with no error surfaced anywhere. The `exception` handler — which previously only logged — now feeds the existing auth-rejection circuit-breaker: on first sight of either error it closes the client (stopping the library's internal retry loop), arms the shared `authCooldownUntil` cooldown (`USER_STREAM_AUTH_COOLDOWN_MS`, default 30min) that already gates `openStreamCallback` re-requests, and schedules the same single delayed retry the Binance breaker uses, so a key fixed in place (permission enabled on the same key) self-heals without a bot restart. First-sight rather than hits-in-window because Kraken's retry cadence (20min–6h per account) never trips a windowed threshold, and a futures subscribe rejects its 3 topics in one burst — the cooldown check collapses the burst to one arming. Flap-alert suppression and the auto-clear on a genuine `executionReport` come free from reusing the shared maps.

### Fixed

- **Hyperliquid socket errors always logged as `Hyperliquid error: {}`.** `JSON.stringify` on a WebSocket `ErrorEvent` only serializes enumerable fields — an `ErrorEvent` has none — so every socket failure was logged with its cause erased. The handler now reads `message`/`error.message`/`type` explicitly.
- **Skipped Hyperliquid candle subscriptions now say *why* translation failed.** The dominant prod case (1,746 log lines since Jun 15) is a producer sending an already-translated wire code (`BTC`, `xyz:GOLD`) where a display pair (`BTC-USDC`) is expected: the subscription is dropped and, since candles publish on display-pair channels, that consumer receives no data. The error now names the resolved display pair so the mismatch is visible in one log line instead of needing a cross-service trace. Root cause fixed on the producer side in main-app core 1.37.8; the diagnostic stays for older/self-hosted producers.

## [1.13.3] - 2026-07-25

### Fixed

- **Hyperliquid park-and-retry silently resolved to NOTHING — the v1.12.0 missed-fill fix has been inert since v1.12.1.** Two defects introduced together in `96c5d89` (v1.12.1) disabled both fallback rungs of the fill resolver, so any parked FILLED whose `userFills` never reached the buffer was dropped exactly as before v1.12.0: order stays `NEW`, deal silently freezes. Only the buffer rung has been working for two releases.
  - **REST rung never ran.** `hlRestLookupOrder`'s precondition guard read `if (!url || !ctx.key || ctx.exchange)` — `ctx.exchange` is `'hyperliquid'`, always truthy, so the guard fired on *every* call and returned `null` before issuing the request. The balancer `/order` lookup was dead code. Missing `!`.
  - **limitPx rung never ran.** v1.12.1 removed the final `emit(buildEvent(order, []))` from `resolve()` (per its "Do not sent raw limitPx" change) but left both log lines still announcing `emitting at limitPx (LAST RESORT)`, the module header documenting step 3, and the tests asserting it. The resolver logged an emit that never happened.
  - **Now: REST is retried before limitPx is ever reached.** `restLookup` runs up to `HL_FILL_REST_RETRIES` (default 3) times with exponential backoff (`HL_FILL_REST_RETRY_DELAY_MS`, default 1000ms, doubling), so a transient balancer/exchange blip no longer costs us the real fill price. limitPx is emitted only once every attempt is spent (worst case ~8s after the FILLED: 5s grace + 1s + 2s). This deliberately re-introduces a bounded limitPx last resort that v1.12.1 removed — the tradeoff is one slightly-off average price versus a permanently frozen deal, now reached only after the retry ladder rather than on the first REST error. **Revisits the v1.12.1 price-accuracy call — flag for semantic review.**
  - **Parked entries stay in the map for the whole ladder** (previously deleted up front, before the `await`). `has()` therefore keeps reporting `true` across the REST backoff, so reconnect-snapshot `userFills` for that cloid are still accepted instead of being dropped by the snapshot gate — and the buffer is re-checked before every REST attempt and once more immediately before the limitPx emit, so late-arriving fills always win on price. Single-emit is preserved by the `resolving` flag.
  - **Overflow eviction no longer silently no-ops.** Entries already mid-resolution can't be force-resolved again, so `park()` now evicts the oldest *non-resolving* entry and logs when every entry is draining (bounded overshoot = arrival rate × retry window) instead of leaving the map to grow past `HL_FILL_PARK_MAX_SIZE` unchecked.
  - New env knobs: `HL_FILL_REST_RETRIES`, `HL_FILL_REST_RETRY_DELAY_MS`. Test coverage grew 7 → 10 in `test/hyperliquidFillPark.test.ts`: the harness's event builders now identify which rung resolved each emit (fills = buffer, commonOrder = REST, neither = limitPx) so a rung can no longer pass by accident — the stale `grace → REST fallback` assertion had been unpassable since v1.12.1 for exactly that reason. Added transient-failure-then-success, fills-landing-mid-retry, and one-emit-under-racing-triggers.

## [1.13.2] - 2026-07-25

### Fixed

- **Bybit price-connector crash-loop on harmless "already subscribed" WS replies — unbounded memory/CPU (bug #121).** Bybit answers a re-subscribe of a still-active topic with `{success:false, ret_msg:"error:already subscribed,topic:tickers.<SYM>"}`, and the vendored v5 client routes *any* `success:false` reply to the `exception` channel. `bybitRestartCb` treated every exception as fatal, so this informational message triggered a full `stopBybit()` + `initBybitWS()` + candle-stream reconnect. Compounding it, the restart path had **no re-entrancy guard** (unlike the `@IdMute`-wrapped candle helpers): the spot/linear/inverse clients each raise `exception` independently, so a burst started overlapping restart cycles — and since `initBybitWS` re-subscribes every ticker topic with 5s sleeps between markets, the overlap double-subscribed topics, producing more `already subscribed` and closing the feedback loop. WS clients/listeners were recreated faster than they were released (~1.3 GB RSS, ~270% CPU reported), until the watchdog saw no ticker data within 50s and — since `handleStall` only isolates `'candle'` stalls — escalated a `connect` stall to a full-worker crash every 40–90s. Fixes: `already subscribed` joins the existing benign-message skip list (`handler not found`, `format error`) and is logged at info rather than error; the restart cycle now runs under a `bybitRestarting` re-entrancy flag that **coalesces** concurrent exceptions into one cycle (deliberately a drop, not the serialising `IdMutex` — queueing would still run N full restarts for N exceptions) and clears in `finally` so later genuine failures still recover. `initBybitWS`'s failure path no longer recurses synchronously (which the guard would swallow) but retries via `setTimeout(wsReconnect)`. Genuinely fatal WS errors still trigger exactly one restart. Regression coverage in `test/bybitRestartStorm.test.ts`.

## [1.13.1] - 2026-07-15

### Fixed

- **Kraken spot OHLC subscribe rejected — "Subscription ohlc interval must be an integer" (bug #77).** `connectKrakenCandleStream` passed the interval to the WS v2 `ohlc` subscribe as a *string* (`"240"`, `"1440"`, `"60"` — as it arrives from the candle room name), but Kraken only accepts a JSON number, so **every** Kraken spot candle WS subscription was rejected — on initial subscribe and again on every reconnect (the client replays the cached payload verbatim). Spot candles therefore never flowed over WS and consumers fell back to REST `getCandles` polling, contributing Kraken `EGeneral:Too many requests` pressure (alert #81). The interval is now coerced to a Kraken-supported integer (`1|5|15|30|60|240|1440|10080|21600`, with a named-interval fallback like `1h`→60), and unsupported values are skipped with a single warn instead of letting Kraken reject them on every replay. Futures (`candles_trade_*`) path unchanged.

## [1.13.0] - 2026-07-06

### Added

- **Kraken tokenized-stock ("xStocks") price feed.** `getKrakenSymbolMaps()` (spot path) now also fetches `getAssetPairs({ aclass: 'tokenized_asset' })` and merges those pairs into the spot symbol maps, so xStock `wsname`s (e.g. `AAPLx/USD`) enter the subscription list consumed by `price/kraken.ts`. Their prices flow to Redis like any Kraken spot pair. Additive + flag-gated behind `KRAKEN_XSTOCKS_ENABLED` (default ON). Default AssetPairs returns zero tokenized pairs, so crypto pairs cannot regress.


## [1.12.0] - 2026-07-06

### Fixed

- **Hyperliquid two-channel fill drop (root cause of the ongoing HL missed fills).** HL splits order data across two WS channels — `orderUpdates` (status only) and `userFills` (the real px/sz, buffered by cloid in `hyperliquidExpirableMap`). `prepareHyperliquidOrder` emitted execution reports from `orderUpdates` and **hard-dropped a FILLED update whose fills weren't buffered** (`if (isFilled && !get) return false`, added in v1.6.3). The drop was deliberate — emitting a FILLED without the buffered fills books it at `limitPx` instead of the real average price (an earlier bug Maksym fixed by dropping) — but any lost/late/expired/reconnect-snapshot `userFills` message then meant the FILLED event was never relayed to main-app, so the order stayed `NEW` and the deal silently froze. Replaced the drop with **park-and-retry** (`src/utils/hyperliquidFillPark.ts`), preserving price accuracy while closing the hole:
  - A FILLED-without-fills update is PARKED in a bounded, TTL'd map (keyed by cloid; `HL_FILL_PARK_MAX_SIZE`, default 5000) instead of dropped.
  - Resolution order (first that yields fills wins): **(1) buffer** — fills arriving on `userFills` during a grace window (`HL_FILL_PARK_GRACE_MS`, default 5s) resolve it immediately with the real average price, exactly as before; **(2) REST** — grace expires with no buffered fill ⇒ one `info.userFillsByTime` lookup (public, address-scoped) fetches the real fills; **(3) limitPx** — REST also fails/empty ⇒ emit at `limitPx` as a loudly-logged last resort (a slightly-off average beats a permanently frozen deal).
  - `userFills` snapshots (replayed on reconnect) are no longer skipped wholesale: snapshot fills are now applied for cloids that have a parked order waiting on them (still gated so unrelated snapshot fills don't re-pollute the buffer — the original reason snapshots were skipped).
  - Interim safety net unchanged: the fill-failsafe detector already reconciles these within ~35–60s; this patches the hole the net was covering. **Changes a deliberate price-accuracy tradeoff — requires semantic review before deploy.**
  - New env knobs: `HL_FILL_PARK_GRACE_MS`, `HL_FILL_PARK_MAX_SIZE`, `HL_FILL_REST_LOOKBACK_MS`. Unit coverage under `test/` (`npm test`): fill-after-park (real price), grace→REST fallback, REST-fail/empty→limitPx, snapshot-fill matches parked update, and size-cap eviction.

## [1.11.4] - 2026-07-05

### Added
- LOCAL-ONLY fault injector for the missed-fill failsafe repro harness: env-gated `DROP_USERSTREAM_FILLS=<clientOrderId|symbol>` (+`DROP_USERSTREAM_FILLS_COUNT`, default 1) suppresses matching FILLED-family paper `executionReport` relays in the paper `cbOrder` path; loud `[FAULT-INJECTOR]` logs; zero real-exchange impact (spec §9.1)

## [1.11.3] - 2026-07-05

### Fixed

- Auth-rejection circuit-breaker (1.11.2) never actually tripped: the failing WS-API frames also flow through the normal `userStreamEvent` path, whose "recovered" clear reset the consecutive auth-error counter every reconnect cycle, so it never reached the threshold (verified on prod — a key with 5 consecutive `-2015`s still looped). Now (a) the auth-error tracker is a **time window** (default 3 within `USER_STREAM_AUTH_WINDOW_MS`=10min) that interleaved frames can't silently reset, and (b) the recovery-clear is gated to **genuine account events** (`executionReport`/`outboundAccountPosition`/`balanceUpdate`/`ORDER_TRADE_UPDATE`/`ACCOUNT_UPDATE`/…) so a rejected key can no longer count its own error frames as recovery. Cooldown/self-retry behaviour unchanged.

### Fixed

- Binance user-stream auth-rejection loop: a rejected API key (`-2015` invalid key/IP/permissions, `-2014`/`-2008`, or HTTP 401) made the WS-API session reconnect every ~60s indefinitely (observed 11 days on one account) — burning Binance request weight, holding the shared per-provider `openStream<provider>` mutex against healthy users, and tripping the user-stream flap watchdog with misleading "connected but dead" pages. Added a circuit-breaker: after `USER_STREAM_AUTH_FAIL_THRESHOLD` (3) consecutive auth errors the room stops and backs off for `USER_STREAM_AUTH_COOLDOWN_MS` (30min) instead of resubscribing, with a single self-retry after the cooldown so a key fixed in place (e.g. egress IP whitelisted without regenerating) self-heals. Flap alerts are suppressed from the first auth error for that room. Auth state clears on the next delivered user-data event; a regenerated key hashes to a new room id and is never gated.

## [1.11.1] - 2026-07-05

### Fixed

- Candle watchdog crash-loop (bybit, binance, okx): the candle liveness signal (`lastDataTrade`) only advanced on *confirmed* (closed) candles, so any candle subscription on an interval ≥~2min looked stalled between closes and the watchdog crash-looped the worker every ~5min (chronic since v1.5.4's confirmed-only change; bybit was actively tripping, binance/okx were latent — kept fresh only by short-interval subs). Liveness now advances on every kline frame (confirmed or not) in all three; publishing stays confirmed-only, so downstream data is unchanged. bitget/kraken/kucoin/hyperliquid were never gated and are unaffected.

### Changed

- Stall isolation: on a candle stall, `BybitConnector` now restarts only its candle streams (targeted `handleStall` recovery) instead of throwing and crashing the whole worker (which also dropped ticker feeds and every other bybit market). Bounded to `maxTargetedRestarts` (2) between real data events before escalating to the previous full-worker restart, so a genuinely dead worker is still recovered. Other connectors keep the throw-based behavior unchanged.

## [1.11.0] - 2026-07-04

### Changed

- Hyperliquid: Unit-bridged spot bases now normalize to their canonical ticker (`UETH→ETH`, `USOL→SOL`, …), derived authoritatively from `spotMeta` `fullName` (never a blanket `U` strip). The raw Unit pair is dual-registered so streams requested under the pre-normalization pair still resolve.

### Fixed

- Hyperliquid: spot candle subscriptions on a display name shared by a perp (e.g. `BTC-USDC`, and the newly-normalized `ETH-USDC`/`SOL-USDC`) now resolve to the spot `@N` stream instead of the perp — futures candles are no longer served to spot bots.

## [1.10.0] - 2026-07-04

### Added
- Price/candle data-stall observability: the price connector's per-channel watchdog now publishes a `{ watchdogStall }` event to the `serviceLog` Redis channel before it self-restarts, so the otherwise-silent recovery is visible to the admin watchdog (Telegram/email).
- User-stream flap detector: a rolling-window reconnect counter per exchange+user (`noteReconnect`) emits a `{ userStreamFlap }` event to `serviceLog` once reconnects cross `USER_STREAM_FLAP_THRESHOLD` (default 4) within `USER_STREAM_FLAP_WINDOW_MS` (default 10 min) — the "connected but dead" signal. Hooked at the reconnect/forced-reconnect sites of Binance, Bybit, Bitget, Kraken, KuCoin, OKX, Coinbase. Strictly emit-only.
- Opt-in per-account user-stream liveness guard (`USER_STREAM_LIVENESS_ENABLED=true`, dark by default): periodically force-recreates a single account's stream when it has delivered no events for `USER_STREAM_LIVENESS_STALE_MS` (default 20 min), healing the "connected but dead" paper/exchange bridge that otherwise leaves bots relying on the reconcile sweep. Per-account (never a global reload — that was reverted), cooldown-gated (`USER_STREAM_LIVENESS_COOLDOWN_MS`, default 60 min), capped per scan (`USER_STREAM_LIVENESS_MAX_PER_SCAN`, default 15), scan interval `USER_STREAM_LIVENESS_SCAN_MS` (default 2 min), paper-only unless `USER_STREAM_LIVENESS_PAPER_ONLY=false`.

### Changed

### Deprecated

### Removed

### Security

## [1.10.0] - 2026-07-03

### Added
- User Stream Watchdog. 

## [1.9.4] - 2026-06-24

### Fixed
- HL balancer: load per-worker caps from Redis at `init()`, not only on the 30s watchdog tick. A multi-IP worker (e.g. 6 IPs → cap 60) was undersized to `defaultWorkerCap` (10) right after boot, so the balancer dropped/self-routed every HL open past 10 until the first tick.
- HL balancer: never open HL locally. `route()` now always claims an HL `open stream` once enabled (even when routing fails — no worker yet / all at cap); a failed route is logged and left for main-app to retry. Previously a failed route fell through and the balancer self-opened the HL stream, double-binding IPs it shares with the worker and hitting its own default 10-cap.

## [1.9.3] - 2026-06-10

### Added
- Binance connection race

## [1.9.2] - 2026-06-08

### Added
- User-stream extension seams

## [1.9.1] - 2026-06-08

### Fixed
- Bitget futures balance

## [1.9.0] - 2026-05-29

### Added
- Hyperliquid IP rotation

## [1.8.0] - 2026-05-28

### Added
- Self-hosted admin-config sync (gated by `ADMIN_CONFIG_ENABLED`). Reads
  `gainium:admin:enabled_exchanges` from Redis, subscribes to
  `gainium:admin:config` pubsub, and runs a 10s periodic refresh as a
  safety net. When the flag is off (cloud / unflagged) every code path
  is a hard no-op — no Redis subscriber, no timers, no log lines.

## [1.7.1] - 2026-05-27

### Fixed
- Improve balancer's load assignment

## [1.7.0] - 2026-05-07

### Added
- Hyperliquid balancer

## [1.6.4] - 2026-05-06

### Fixed
- Kraken free asset

## [1.6.3] - 2026-05-05

### Fixed
- Hyperliquid do not send filled order updates if no fills

## [1.6.2] - 2026-05-05

### Fixed
- Hyperliquid handle infinite loop

## [1.6.1] - 2026-05-05

### Changed
- Hyperliquid max connections 10
- Hyperliquid reconnection params

## [1.6.0] - 2026-05-04

### Added
- Hyperliquid HIP-3 support

## [1.5.4] - 2026-04-29

### Changed
- Send only closed candles in Binance, OKX and Bybit

## [1.5.3] - 2026-04-27

### Fixed
- Binance new urls

## [1.5.2] - 2026-04-27

### Changed
- Rabbit and Mutex logic

## [1.5.1] - 2026-04-24

### Changed
- Binance spot stream

## [1.5.0] - 2026-04-08

### Added
- Kucoin futures stream

## [1.4.9] - 2026-04-07

### Fixed
- Handle Kraken execeptions
- Kraken spot candles request

## [1.4.8] - 2026-03-24

### Changed
- Hyperliquid pairs mapping

## [1.4.7] - 2026-03-23

### Changed
- Increase Hyperliquid timeouts

## [1.4.6] - 2026-03-20

### Fixed
- Hyperliquid reconnection

## [1.4.5] - 2026-03-19

### Fixed
- Hyperliquid max connections

## [1.4.4] - 2026-03-18

### Changed
- Hyperliquid reconnection

## [1.4.3] - 2026-03-16

### Fixed
- Hyperliquid reconnection logic

## [1.4.2] - 2026-03-13

### Changed
- Hyperliquid candles logic

## [1.4.1] - 2026-03-09

### Changed
- Drop Kraken Coinnm support

## [1.4.0] - 2026-03-04

### Added
- Kraken

## [1.3.4] - 2026-02-27

### Changed
- Drop support for legacy Binance keys

## [1.3.3] - 2026-02-20

### Changed
- Debug hyperliquid fills

## [1.3.2] - 2026-02-06

### Changed
- Added OKX host app.okx.com

## [1.3.1] - 2026-01-29

### Fixed
- Truncate keys

## [1.3.0] - 2026-01-29

### Added
- Test connection

## [1.2.1] - 2026-01-28

### Fixed
- Error stringify

## [1.2.0] - 2026-01-28

### Added
- Support Binance ED25519 keys. 
- Websocket API for Spot user data streams. 

## [1.1.7] - 2025-12-12

### Fixed
- Hyperliquid max order size.  

## [1.1.6] - 2025-11-17

### Changed
- Hyperliquid orders processing.  

## [1.1.5] - 2025-11-06

### Changed
- Hyperliquid candle connect.  

## [1.1.4] - 2025-10-22

### Changed
- Bitget unique message id. 

## [1.1.3] - 2025-10-21

### Fixed
- Paper WS url. 

## [1.1.2] - 2025-09-29

### Changed
- Increased hyperliquid expirable map timeout. 
- Price connector transport settings. 

### Fixed
- Order update timestamp. 

## [1.1.1] - 2025-09-26

### Changed
- Hyperliquid user stream logic. 

## [1.1.0] - 2025-09-24

### Added
- Hyperliquid support. Price stream, candle stream, order updates stream. Order fills saved in temp storage to use in market order price calculation. 

## [1.0.12] - 2025-09-17

### Added
- Connect to selected exchanges using PRICE_CONNECTOR_EXCHANGES env value

## [1.0.11] - 2025-09-15

### Added
- Restart all streams method

## [1.0.10] - 2025-08-05

### Fixed
- Binance fix reconnect init

## [1.0.9] - 2025-07-25

### Fixed
- Bybit fix reconnect after connection closed

### Changed
- Bumped dependecies versions

## [1.0.8] - 2025-07-18

### Changed
- Bybit reconnect timeout set 2s

## [1.0.7] - 2025-07-16

### Added
- Added support for changing Bybit host (com, eu, nl, tr, kz, ge)
- Added BybitHost enum with supported host options
- Added bybitHostMap for mapping host types to WebSocket URLs
- Added bybitHost optional parameter to OpenStreamInput interface

### Changed
- Updated Bybit WebSocket connector to use configurable host URL
- Enhanced UserConnector to support dynamic Bybit host selection

## [1.0.6] - 2025-07-03

### Fixed
- Fixed Bybit ticker issue where only 500 tickers were being used to receive ticker updates

## [1.0.5] - 2025-07-02

### Changed
- Updated multiple dev dependencies to latest versions:
  - @eslint/js: ^9.29.0 → ^9.30.1
  - @types/node: ^24.0.4 → ^24.0.10
  - @typescript-eslint/eslint-plugin: ^8.35.0 → ^8.35.1
  - @typescript-eslint/parser: ^8.35.0 → ^8.35.1
  - eslint: ^9.29.0 → ^9.30.1
  - globals: ^16.2.0 → ^16.3.0
- Updated runtime dependencies:
  - binance: ^2.15.22 → ^3.0.0 (major version update)
  - dotenv: ^16.6.0 → ^17.0.1 (major version update)
  - ws: ^8.18.2 → ^8.18.3
- Updated code to work with new binance package v3.0.0:
  - Added WS_KEY_MAP import
  - Updated websocket event handling (data.ws.target.url → data.wsUrl)
  - Changed error event listener ('error' → 'exception')
- Updated other exchange connectors to maintain compatibility

## [1.0.4] - 2025-06-30

### Changed
- Switched to npm package manager
- Removed yarn.lock file (no longer needed with npm)

## [2025-06-27]

### Changed
- Bumped dependencies to fix known vulnerabilities.
- Updated code to fit new version of exchange packages.

## [2025-06-26]

### Added
- Add health server for Docker health checks
- Integrate Husky pre-commit hooks
- New health server utility for monitoring application status

### Changed
- Improve Docker integration and environment variables
- Refactor price connector worker system
- Update package dependencies and linting configuration
- Enhanced environment variable handling
- Update kucoin-api dependency to 1.0.4 with broker partner header condition fix (check secrets existence)

### Fixed
- Fix environment name configuration
- Remove outdated code and improve code quality
- Various lint fixes and dependency updates
