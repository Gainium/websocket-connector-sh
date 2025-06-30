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
