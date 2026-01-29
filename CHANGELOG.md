# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

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
