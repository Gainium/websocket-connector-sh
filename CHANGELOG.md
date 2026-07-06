# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.13.0] - 2026-07-06

### Added

- **Kraken tokenized-stock ("xStocks") price feed.** `getKrakenSymbolMaps()` (spot path) now also fetches `getAssetPairs({ aclass: 'tokenized_asset' })` and merges those pairs into the spot symbol maps, so xStock `wsname`s (e.g. `AAPLx/USD`) enter the subscription list consumed by `price/kraken.ts`. Their prices flow to Redis like any Kraken spot pair. Additive + flag-gated behind `KRAKEN_XSTOCKS_ENABLED` (default ON). Default AssetPairs returns zero tokenized pairs, so crypto pairs cannot regress.


## [1.12.0] - 2026-07-06

### Fixed

- **Hyperliquid two-channel fill drop (root cause of the ongoing HL missed fills).** HL splits order data across two WS channels — `orderUpdates` (status only) and `userFills` (the real px/sz, buffered by cloid in `hyperliquidExpirableMap`). `prepareHyperliquidOrder` emitted execution reports from `orderUpdates` and **hard-dropped a FILLED update whose fills weren't buffered** (`if (isFilled && !get) return false`, added in v1.6.3). The drop was deliberate — emitting a FILLED without the buffered fills books it at `limitPx` instead of the real average price (an earlier bug Maksym fixed by dropping) — but any lost/late/expired/reconnect-snapshot `userFills` message then meant the FILLED event was never relayed to main-app, so the order stayed `NEW` and the deal silently froze. Replaced the drop with **park-and-retry** (`src/utils/hyperliquidFillPark.ts`), preserving price accuracy while closing the hole:
  - A FILLED-without-fills update is PARKED in a bounded, TTL'd map (keyed by cloid; `HL_FILL_PARK_MAX_SIZE`, default 5000) instead of dropped.
  - Resolution order (first that yields fills wins): **(1) buffer** — fills arriving on `userFills` during a grace window (`HL_FILL_PARK_GRACE_MS`, default 5s) resolve it immediately with the real average price, exactly as before; **(2) REST** — grace expires with no buffered fill ⇒ one `info.userFillsByTime` lookup (public, address-scoped) fetches the real fills; **(3) limitPx** — REST also fails/empty ⇒ emit at `limitPx` as a loudly-logged last resort (a slightly-off average beats a permanently frozen deal).
  - `userFills` snapshots (replayed on reconnect) are no longer skipped wholesale: snapshot fills are now applied for cloids that have a parked order waiting on them (still gated so unrelated snapshot fills don't re-pollute the buffer — the original reason snapshots were skipped).
  - Interim safety net unchanged: the fill-failsafe detector already reconciles these within ~35–60s; this patches the hole the net was covering. **Changes Maksym's deliberate price-accuracy tradeoff — requires his semantic review before deploy (ClickUp 86ey5zc49 §1).**
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
