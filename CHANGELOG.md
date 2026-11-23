# Changelog

## v2.0.1 — 2026-11-23
- Rewrote all code comments, README, and CHANGELOG in English. No functional changes.

## v2 — 2026-11-19
First version under version control.
- Captures the filters on the query page; any date matching the capture date is rolled forward to today
- Polls every 5 minutes and sends new PMR consults to Telegram (department and deadline only)
- Immediate alert on session expiry, alert after 3 consecutive failures, recovery notice, daily heartbeat
- Token, Chat ID, and saved query are stored only in local `localStorage`

### Development history (not under version control)
- v1: Re-fetched the current URL with GET — actually received the query page, so the list was never read
- v1.1: Skipped repeated header rows
- v1.2: Added form-default and manual "Copy as fetch" request strategies
- v1.3: Switched to capturing the query on the query page (verified working)
- v2: Removed unused strategies and simplified the code

<!-- For each release: add a "## vX — date" entry at the top, bump the version in the script header, and create a tag (git tag vX). -->
