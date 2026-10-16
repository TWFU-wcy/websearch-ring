# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-16

Security/robustness hardening pass from a full source review.

### Fixed

- **Exa API key no longer travels in the URL alone.** It is now sent in the
  `X-Exa-Api-Key` header *and* kept in the query string as a fallback, so the key
  does not land in upstream access logs when the endpoint understands the header.
- **Upstream response bodies are capped (DoS).** A new `readBody` helper enforces
  a 5 MB limit (checked via `Content-Length` and by streaming) for all three
  vendors, replacing unbounded `res.text()` / `res.json()` calls. An oversized
  body surfaces as a normal vendor failure and the ring rotates on.
- **Cancelling one coalesced waiter no longer fails the others.** When a shared
  request is aborted because every waiter left, waiters whose own signal did not
  fire are transparently retried instead of receiving the cancellation error.

### Added

- `WEBSEARCH_MAX_INFLIGHT` environment variable (default 16, range 1–256): bounds
  how many distinct queries hit the vendors at once. Excess queries **queue**
  (FIFO) instead of being rejected, and a `concurrency limit reached` hint is
  logged to stderr when the ring is saturated.
- `readBody`, `createSemaphore`, `MAX_BODY_BYTES` are exported for testing.
- Tests for the body cap, the Exa header, the semaphore/concurrency bound, and
  the coalesced-cancel retry path.

### Changed

- README documents the new variable, the body cap, and the corrected shutdown
  behaviour (stdin close waits for in-flight replies rather than aborting them).
- `numResults` non-integer truncation is now explicitly documented.

## [1.1.0] - 2026-10-15

Hardening release: no more silently swallowed configuration errors, no unbounded
cache growth, and a test suite that actually asserts.

### Fixed

- **Configuration values are validated strictly.** `WEBSEARCH_TIMEOUT_MS`,
  `WEBSEARCH_MAX_CHARS`, `WEBSEARCH_TTL_MS` and the new `WEBSEARCH_CACHE_MAX`
  must be integers within a documented range. Previously `WEBSEARCH_TIMEOUT_MS=12s`
  became `NaN`, `AbortSignal.timeout(NaN)` threw inside the per-vendor `catch`,
  and the user only ever saw `All search vendors failed`; `WEBSEARCH_MAX_CHARS`
  `NaN` silently disabled truncation; `WEBSEARCH_TTL_MS=""` silently turned the
  cache off. A bad value is now reported verbatim — with the variable name, the
  received value and the expected format — to both stderr and the `tools/call`
  response, and no vendor request is attempted while the configuration is broken.
- **The TTL cache is bounded (memory leak).** The cache was an unbounded `Map`
  whose expired entries were only removed when the very same key was requested
  again, so a long-lived server grew monotonically with the number of distinct
  queries. It is now a TTL + LRU cache with a configurable capacity
  (`WEBSEARCH_CACHE_MAX`, default 512) plus a periodic sweep on an `unref()`'d
  timer, and cache hits/evictions are logged to stderr.
- **Out-of-range HTML numeric entities no longer fail a vendor.** `&#999999999;`
  or `&#xD800;` used to make `String.fromCodePoint` throw, which was reported as
  the whole vendor failing. Invalid code points now keep their original text.
- **Exa responses are parsed in both shapes.** Only `data:` SSE frames were
  understood; a plain JSON body (which the `Accept` header also allows) was
  reported as an empty response and permanently demoted exa. Both are parsed now,
  and the error message distinguishes a changed upstream format from a genuinely
  empty answer (content-type + first bytes included).
- **Tool input validation.** `numResults` is truncated to an integer and clamped
  to 1–20 (`3.7` → `3`, `0` → `1`); non-numeric values return JSON-RPC `-32602`
  instead of being silently replaced by the default. `query` must be a non-empty
  string of at most 1000 characters.
- **`WEBSEARCH_VENDORS` misconfiguration is reported.** An empty list or unknown
  vendor names used to produce a dangling `Attempts:\n- `; the error now names
  the legal values (`exa, tavily, bing`).
- **`notifications/cancelled` is honoured.** A cancelled request now aborts the
  in-flight upstream fetch, cleans up the inflight bookkeeping, never writes its
  result into the cache, and is not answered. Replies for requests that were
  already received are still flushed when stdin closes (`… | node index.js`
  one-shot usage keeps working).
- **Clean shutdown on Windows.** `process.exit()` while libuv still had a closing
  socket/DNS handle aborted the process (`Assertion failed: !(handle->flags &
  UV_HANDLE_CLOSING)`, exit code `0xC0000409`). Shutdown now closes the fetch
  dispatcher and lets the event loop drain.
- **`serverInfo.version` no longer hardcodes `1.0.0`.** It is read from
  `package.json`, so it can not drift from the published version.

### Added

- `test/unit.test.mjs` and `test/server.test.mjs` (47 deterministic tests, no
  network): config parsing, entity decoding, exa/tavily/bing parsing, cache
  eviction/expiry, cache-hit and coalescing paths, cancellation, render output,
  JSON-RPC error codes, and real stdio process tests.
- `smoke-test.mjs` now asserts on every reply (response id, non-empty
  `content[0].text`, result format, `, cached` on an identical repeat call,
  correct error codes) and exits non-zero on any failed assertion. `--offline`
  runs the protocol/validation/cancellation checks without touching the network.
- CI runs the unit/process tests and the offline smoke test in the blocking job;
  the network smoke test moved to a separate, non-blocking job.
- `WEBSEARCH_CACHE_MAX` environment variable.
- Package metadata: `repository`, `homepage`, `bugs`, `author`, `exports`.
  Importing the module no longer starts the server (the stdio loop only starts on
  direct execution), and the testable helpers are exported.
- This changelog.

### Changed

- Render/truncation, cache and HTTP helpers accept explicit dependencies so they
  can be tested without the network.

## [1.0.0] - 2026-09-23

### Added

- Initial release: keyless-first `exa → tavily → bing` rotation with automatic
  failover, per-vendor timeout, TTL cache, identical-request coalescing,
  `via`/`attempts` transparency, single-file zero-dependency stdio MCP server.

[1.1.0]: https://github.com/TWFU-wcy/websearch-ring/releases/tag/v1.1.0
[1.0.0]: https://github.com/TWFU-wcy/websearch-ring/releases/tag/v1.0.0
