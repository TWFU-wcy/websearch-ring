#!/usr/bin/env node
// websearch-ring — MCP stdio server
//
// Multi-vendor web search with keyless-first rotation and automatic failover.
// Works in any MCP client (MiMo Desktop, Hermes, Claude Code, Cursor, ...).
//
// Env (all optional):
//   WEBSEARCH_VENDORS     comma list, default "exa,tavily,bing"
//   WEBSEARCH_TIMEOUT_MS  per-vendor timeout in ms, default 12000
//   WEBSEARCH_MAX_CHARS   result text cap in chars, default 12000
//   WEBSEARCH_TTL_MS      cache TTL in ms, default 1200000 (0 disables)
//   WEBSEARCH_CACHE_MAX   max cached queries (LRU-evicted), default 512
//   EXA_API_KEY           optional; keyless public endpoint used when unset
//   TAVILY_API_KEY        optional; keyless access mode used when unset
//   WEBSEARCH_UA          User-Agent for the Bing vendor
//
// Numeric env values are validated strictly. A bad value is a configuration
// error that is surfaced to the caller verbatim — it never degrades into the
// misleading "All search vendors failed".
//
// Outbound requests carry no user identifiers.
//
// Importing this module has no side effects: the stdio server only starts when
// this file is executed directly (node index.js / the `websearch-ring` bin).
// Pure helpers are exported so they can be unit-tested without the network.

import readline from "node:readline";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- logging

// stdout is the JSON-RPC channel — diagnostics must go to stderr only.
export const log = (...a) => process.stderr.write(`[websearch-ring] ${a.join(" ")}\n`);
const noop = () => {};
const shorten = (s, n = 60) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ---------------------------------------------------------------- version

// package.json is the single source of truth for the version (no hardcoding).
export function readPackageVersion(metaUrl = import.meta.url) {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", metaUrl), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch (err) {
    log(`could not read package.json for the version (${err?.message || err}); falling back to 0.0.0`);
    return "0.0.0";
  }
}

export const VERSION = readPackageVersion();

// ---------------------------------------------------------------- config

export const VENDOR_NAMES = ["exa", "tavily", "bing"];
export const DEFAULT_VENDORS = ["exa", "tavily", "bing"];
export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// min/max are inclusive; `def` is also the value used when the variable is
// unset, empty/whitespace-only, or invalid (invalid additionally records an
// error, so behaviour is deterministic in all three cases).
export const NUMERIC_SPECS = {
  WEBSEARCH_TIMEOUT_MS: { def: 12000, min: 1, max: 600000 },
  WEBSEARCH_MAX_CHARS: { def: 12000, min: 1, max: 10000000 },
  WEBSEARCH_TTL_MS: { def: 1200000, min: 0, max: 2592000000 },
  WEBSEARCH_CACHE_MAX: { def: 512, min: 1, max: 100000 },
};

export function parseIntegerVar(name, raw, spec) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!text) return { name, value: spec.def, source: "default", raw, error: null };
  if (!/^[+-]?\d+$/.test(text)) {
    return {
      name,
      value: spec.def,
      source: "invalid",
      raw,
      error: `${name}=${JSON.stringify(String(raw))} is not a valid number: expected an integer between ${spec.min} and ${spec.max} (received ${JSON.stringify(text)}).`,
    };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    return {
      name,
      value: spec.def,
      source: "invalid",
      raw,
      error: `${name}=${JSON.stringify(String(raw))} is out of range: expected an integer between ${spec.min} and ${spec.max}.`,
    };
  }
  return { name, value, source: "env", raw, error: null };
}

export function parseConfig(env = process.env) {
  const errors = [];
  const sources = {};
  const numbers = {};

  for (const [name, spec] of Object.entries(NUMERIC_SPECS)) {
    const parsed = parseIntegerVar(name, env[name], spec);
    numbers[name] = parsed.value;
    sources[name] = parsed.source;
    if (parsed.error) errors.push(parsed.error);
  }

  let vendors = DEFAULT_VENDORS.slice();
  sources.WEBSEARCH_VENDORS = "default";
  const rawVendors = env.WEBSEARCH_VENDORS;
  if (rawVendors !== undefined && rawVendors !== null && String(rawVendors).trim() !== "") {
    const requested = String(rawVendors)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const list = [...new Set(requested)];
    const unknown = list.filter((n) => !VENDOR_NAMES.includes(n));
    if (!list.length) {
      sources.WEBSEARCH_VENDORS = "invalid";
      errors.push(
        `WEBSEARCH_VENDORS=${JSON.stringify(String(rawVendors))} selects no vendor: expected a comma-separated list of ${VENDOR_NAMES.join(", ")}.`,
      );
    } else if (unknown.length) {
      sources.WEBSEARCH_VENDORS = "invalid";
      errors.push(
        `WEBSEARCH_VENDORS=${JSON.stringify(String(rawVendors))} contains unknown vendor(s) ${unknown.map((n) => JSON.stringify(n)).join(", ")}: valid names are ${VENDOR_NAMES.join(", ")}.`,
      );
    } else {
      sources.WEBSEARCH_VENDORS = "env";
    }
    const known = list.filter((n) => VENDOR_NAMES.includes(n));
    vendors = known.length ? known : DEFAULT_VENDORS.slice();
  }

  const ua = env.WEBSEARCH_UA && String(env.WEBSEARCH_UA).trim() ? String(env.WEBSEARCH_UA) : DEFAULT_UA;
  sources.WEBSEARCH_UA = ua === DEFAULT_UA ? "default" : "env";
  const exaApiKey = env.EXA_API_KEY && String(env.EXA_API_KEY).trim() ? String(env.EXA_API_KEY) : null;
  const tavilyApiKey = env.TAVILY_API_KEY && String(env.TAVILY_API_KEY).trim() ? String(env.TAVILY_API_KEY) : null;

  return {
    vendors,
    timeoutMs: numbers.WEBSEARCH_TIMEOUT_MS,
    maxChars: numbers.WEBSEARCH_MAX_CHARS,
    ttlMs: numbers.WEBSEARCH_TTL_MS,
    cacheMax: numbers.WEBSEARCH_CACHE_MAX,
    ua,
    exaApiKey,
    tavilyApiKey,
    sources,
    errors,
    ok: errors.length === 0,
  };
}

// Caller-visible text for a bad configuration. Never swallowed by the vendor ring.
export function formatConfigError(config) {
  const lines = [
    "websearch-ring is misconfigured, so no search was performed. Fix the environment variable(s) below and restart the MCP server:",
  ];
  for (const e of config.errors) lines.push(`- ${e}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- html / text

export const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–",
  middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷",
};

// String.fromCodePoint throws RangeError for out-of-range/NaN code points, and
// lone surrogates are not valid text. Return null so callers keep the raw text:
// a bogus entity in one page must never fail the whole vendor.
export function codePointToString(cp) {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return null;
  if (cp >= 0xd800 && cp <= 0xdfff) return null;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return null;
  }
}

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePointToString(parseInt(hex, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, dec) => codePointToString(Number(dec)) ?? m)
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

export function clampSnippet(s, n = 400) {
  const clean = decodeEntities(s);
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

// ---------------------------------------------------------------- http

export const TIMEOUT_ERROR = "timeout";

export class CancelledError extends Error {
  constructor(message = "request cancelled by client") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelled(err, signal) {
  return err instanceof CancelledError || err?.name === "CancelledError" || signal?.aborted === true;
}

// AbortSignal.timeout(NaN) throws RangeError synchronously; validate first so a
// bad value can never masquerade as an upstream failure.
export function buildRequestSignal(timeoutMs, external) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `invalid timeout ${JSON.stringify(timeoutMs)}: expected a positive integer number of milliseconds`,
    );
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (external.aborted) return external;
  const merged = new AbortController();
  timeout.addEventListener("abort", () => merged.abort(timeout.reason), { once: true });
  external.addEventListener("abort", () => merged.abort(external.reason), { once: true });
  return merged.signal;
}

export async function http(url, options = {}, ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? NUMERIC_SPECS.WEBSEARCH_TIMEOUT_MS.def;
  const external = ctx.signal;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available (Node.js >= 18 required)");
  if (external?.aborted) throw new CancelledError();
  let signal;
  try {
    signal = buildRequestSignal(timeoutMs, external);
  } catch (err) {
    throw new Error(`refusing to send request: ${err.message}`);
  }
  try {
    return await fetchImpl(url, { ...options, signal });
  } catch (err) {
    // Client cancel first: it must never be reported as a vendor timeout.
    if (external?.aborted) throw new CancelledError();
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new Error(TIMEOUT_ERROR);
    throw err;
  }
}

// ---------------------------------------------------------------- vendors

const RATE_LIMIT_RE =
  /rate limit|rate-limit|quota (?:exhausted|exceeded)|too many requests|usage limit|create your own .{0,18}api key|sign up for a free api key/i;

const firstContentText = (parsed) => {
  const t = parsed?.result?.content?.[0]?.text;
  return typeof t === "string" && t.trim() ? t : null;
};

// Accepts both the SSE ("data: {...}") and the plain-JSON shapes an MCP
// endpoint may answer with, and reports *why* no text was found.
export function extractExaText(body) {
  const raw = String(body ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return { text: null, format: "empty", detail: "response body is empty" };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return { text: null, format: "json", detail: `body starts like JSON but does not parse: ${err.message}` };
    }
    const text = firstContentText(parsed);
    if (text) return { text, format: "json" };
    const rpc = parsed?.error?.message;
    return {
      text: null,
      format: "json",
      detail: rpc ? `upstream JSON-RPC error: ${rpc}` : "JSON body has no result.content[0].text",
    };
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const frame = /^data:\s?(.*)$/.exec(line.trim());
    if (!frame) continue;
    const payload = frame[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      const text = firstContentText(parsed);
      if (text) return { text, format: "sse" };
    } catch {
      /* not a JSON frame; keep scanning */
    }
  }
  return { text: null, format: "sse", detail: "no SSE data frame contained result.content[0].text" };
}

export function parseExaItems(text) {
  const items = [];
  for (const block of String(text).split(/\n-{3,}\n/)) {
    const url_ = /^URL:\s*(.+)$/m.exec(block);
    if (!url_) continue;
    const title = /^Title:\s*(.+)$/m.exec(block);
    const published = /^Published:\s*(.+)$/m.exec(block);
    const body_ = block.replace(/^(Title|URL|Published|Author):.*$/gm, "").replace(/^Highlights:\s*$/m, "").trim();
    const worth = (v) => (v && v.trim().toUpperCase() !== "N/A" ? v.trim() : null);
    // Exa often reports Title: N/A; fall back to the first real line of the body.
    const fallbackTitle = body_
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").replace(/^\.\.\.$/, "").trim())
      .find(Boolean);
    items.push({
      title: decodeEntities(worth(title?.[1]) || fallbackTitle || url_[1]),
      url: url_[1].trim(),
      snippet: clampSnippet(body_),
      date: worth(published?.[1]) ?? undefined,
    });
  }
  return items;
}

export async function exa(query, count, ctx = {}) {
  const url = ctx.exaApiKey
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(ctx.exaApiKey)}`
    : "https://mcp.exa.ai/mcp";
  const res = await http(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query, type: "auto", numResults: count, livecrawl: "fallback" },
        },
      }),
    },
    ctx,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const { text, format, detail } = extractExaText(body);
  const contentType = res.headers?.get?.("content-type") || "unknown";
  if (!text) {
    throw new Error(
      `no usable text in response (${format}${detail ? `: ${detail}` : ""}; content-type: ${contentType}; first bytes: ${JSON.stringify(shorten(body.replace(/\s+/g, " "), 160))})`,
    );
  }

  const items = parseExaItems(text);
  if (items.length) return items;

  // Exa reports throttling and other refusals as a 200 with a prose body, so
  // surface those as failures and let the ring move on to the next vendor.
  if (RATE_LIMIT_RE.test(text)) throw new Error("rate limited");
  return [{ title: "Exa result", url: "", snippet: clampSnippet(text, 1200) }];
}

export function parseTavilyResults(data) {
  return (data?.results || []).map((r) => ({
    title: decodeEntities(r.title || r.url || ""),
    url: r.url || "",
    snippet: clampSnippet(r.content || ""),
    score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
  }));
}

export async function tavily(query, count, ctx = {}) {
  const headers = { "Content-Type": "application/json" };
  if (ctx.tavilyApiKey) headers.Authorization = `Bearer ${ctx.tavilyApiKey}`;
  else headers["X-Tavily-Access-Mode"] = "keyless";
  const res = await http(
    "https://api.tavily.com/search",
    { method: "POST", headers, body: JSON.stringify({ query, max_results: count }) },
    ctx,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = parseTavilyResults(data);
  if (!items.length) throw new Error("no results");
  return items;
}

// Bing wraps some result links in a redirect; recover the real target.
export function decodeBingUrl(href) {
  if (!href) return null;
  const m = /[?&]u=a1([^&]+)/.exec(href);
  if (m) {
    try {
      let b64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      /* fall through to the raw href */
    }
  }
  return href.startsWith("http") ? href : null;
}

export function parseBingResults(html, count) {
  const items = [];
  for (const block of String(html).match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url_ = decodeBingUrl(link[1]);
    if (!url_) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    items.push({
      title: decodeEntities(link[2]),
      url: url_,
      snippet: clampSnippet(snippet?.[1] || ""),
    });
    if (items.length >= count) break;
  }
  return items;
}

export async function bing(query, count, ctx = {}) {
  const res = await http(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": ctx.ua || DEFAULT_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } },
    ctx,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const items = parseBingResults(html, count);
  if (!items.length) throw new Error("no results (page layout may have changed)");
  return items;
}

export const REGISTRY = { exa, tavily, bing };

// ---------------------------------------------------------------- cache

// Bounded TTL + LRU cache. Insertion order doubles as recency order, so the
// oldest entry is evicted when maxEntries is exceeded. Expired entries are
// dropped on access and by sweep() (which the server also runs on an unref'd
// timer), so entries for queries nobody asks about again cannot pile up.
export function createCache({ ttlMs = 0, maxEntries = 512, now = Date.now, log: logger = noop } = {}) {
  const entries = new Map();
  const counters = { hits: 0, misses: 0, expired: 0, evictions: 0, swept: 0 };
  const enabled = Number.isInteger(ttlMs) && ttlMs > 0;

  function get(key) {
    if (!enabled) return null;
    const hit = entries.get(key);
    if (!hit) {
      counters.misses += 1;
      return null;
    }
    if (now() > hit.expiresAt) {
      entries.delete(key);
      counters.expired += 1;
      counters.misses += 1;
      return null;
    }
    // refresh recency (Map preserves insertion order)
    entries.delete(key);
    entries.set(key, hit);
    counters.hits += 1;
    return hit.value;
  }

  function set(key, value) {
    if (!enabled) return;
    if (entries.has(key)) entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      counters.evictions += 1;
      logger(`cache full — evicted least-recently-used query (size ${entries.size}/${maxEntries})`);
    }
  }

  function sweep() {
    if (!enabled) return 0;
    const t = now();
    let removed = 0;
    for (const [key, hit] of entries) {
      if (t > hit.expiresAt) {
        entries.delete(key);
        removed += 1;
      }
    }
    counters.swept += removed;
    return removed;
  }

  const stats = () => ({ size: entries.size, max: maxEntries, ttlMs, enabled, ...counters });

  return { get, set, sweep, stats, has: (k) => entries.has(k), clear: () => entries.clear() };
}

// ---------------------------------------------------------------- engine

export function cacheKey(query, count) {
  return `${String(query).trim().toLowerCase().replace(/\s+/g, " ")}::${count}`;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function createSearchEngine({
  vendors = DEFAULT_VENDORS,
  registry = REGISTRY,
  cache = createCache({ ttlMs: 0, maxEntries: 1 }),
  timeoutMs = NUMERIC_SPECS.WEBSEARCH_TIMEOUT_MS.def,
  exaApiKey = null,
  tavilyApiKey = null,
  ua = DEFAULT_UA,
  fetchImpl,
  log: logger = noop,
} = {}) {
  const inflight = new Map();
  const vendorCtx = { timeoutMs, exaApiKey, tavilyApiKey, ua, fetchImpl };

  async function runSearch(query, count, signal) {
    const key = cacheKey(query, count);
    const attempts = [];
    for (const name of vendors) {
      const vendor = registry[name];
      if (typeof vendor !== "function") {
        logger(`unknown vendor in WEBSEARCH_VENDORS: ${name}`);
        attempts.push(`${name}: unknown vendor`);
        continue;
      }
      if (signal?.aborted) throw new CancelledError();
      try {
        const items = await vendor(query, count, { ...vendorCtx, signal });
        if (signal?.aborted) throw new CancelledError();
        const value = { vendor: name, items };
        cache.set(key, value);
        logger(`vendor ${name} served "${shorten(query)}" (${items.length} results)`);
        return { ...value, cached: false, attempts, key };
      } catch (err) {
        // A cancelled request must not fall through to the next vendor.
        if (isCancelled(err, signal)) throw new CancelledError();
        attempts.push(`${name}: ${err.message}`);
        logger(`vendor ${name} failed (${err.message}), trying next`);
      }
    }
    return { vendor: null, items: [], cached: false, attempts, key };
  }

  async function search(query, count, { signal } = {}) {
    const key = cacheKey(query, count);

    const cached = cache.get(key);
    if (cached) {
      const { size, max, hits, evictions } = cache.stats();
      logger(`cache hit for "${shorten(query)}" (entries ${size}/${max}, hits ${hits}, evictions ${evictions})`);
      // render() reads result.attempts.length unconditionally; a cache hit never
      // ran the vendor ring, so hand back an empty list rather than undefined.
      return { ...cached, attempts: [], cached: true, key };
    }

    // Identical concurrent calls (subagent fan-outs) share one backend request.
    let entry = inflight.get(key);
    let owner = false;
    if (!entry) {
      owner = true;
      const controller = new AbortController();
      entry = { controller, waiters: 0, settled: false, promise: null };
      entry.promise = runSearch(query, count, controller.signal);
      inflight.set(key, entry);
      entry.promise
        .then(
          () => {
            entry.settled = true;
          },
          () => {
            entry.settled = true;
          },
        )
        .finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
        });
    }
    entry.waiters += 1;

    try {
      const value = await withAbort(entry.promise, signal);
      return owner ? value : { ...value, coalesced: true };
    } finally {
      entry.waiters -= 1;
      if (entry.waiters <= 0) {
        // Nobody is waiting any more: stop the shared request so a cancelled
        // search cannot keep running (nor write its result into the cache).
        if (!entry.settled) entry.controller.abort(new CancelledError("no waiters left"));
        if (inflight.get(key) === entry) inflight.delete(key);
      }
    }
  }

  return { search, runSearch, stats: () => ({ ...cache.stats(), inflight: inflight.size }) };
}

// ---------------------------------------------------------------- render

export function renderResult(result, { query, maxChars = NUMERIC_SPECS.WEBSEARCH_MAX_CHARS.def } = {}) {
  if (!result.vendor) {
    const attempts = result.attempts || [];
    if (!attempts.length) {
      return [
        `No search vendor could run for "${query}".`,
        "No vendor was attempted — WEBSEARCH_VENDORS is empty or selects vendors that do not exist.",
        `Set WEBSEARCH_VENDORS to a comma-separated list of: ${VENDOR_NAMES.join(", ")}.`,
      ].join("\n");
    }
    return `All search vendors failed for "${query}".\nAttempts:\n- ${attempts.join("\n- ")}`;
  }
  const lines = [];
  const tag = result.cached ? ", cached" : result.coalesced ? ", shared with a concurrent call" : "";
  lines.push(`${result.items.length} results for "${query}" (via ${result.vendor}${tag})`);
  if (result.attempts?.length) {
    lines.push(`Note: earlier vendors failed and were skipped — ${result.attempts.join("; ")}`);
  }
  lines.push("");
  result.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}`);
    if (it.url) lines.push(`   ${it.url}`);
    if (it.date) lines.push(`   published: ${it.date}`);
    if (it.snippet) lines.push(`   ${it.snippet}`);
    lines.push("");
  });
  const text = lines.join("\n").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[TRUNCATED at ${maxChars} chars]` : text;
}

// ---------------------------------------------------------------- MCP

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const TOOL_NAME = "web_search";
export const MAX_QUERY_CHARS = 1000;
export const MIN_NUM_RESULTS = 1;
export const MAX_NUM_RESULTS = 20;
export const DEFAULT_NUM_RESULTS = 8;

export const TOOLS = [
  {
    name: TOOL_NAME,
    description:
      "Search the web. Rotates across multiple keyless search backends with automatic failover, so it stays available regardless of which chat model or provider the client uses. Returns titles, URLs and snippets, and reports which backend served the result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: `Search query (1–${MAX_QUERY_CHARS} characters)` },
        numResults: {
          type: "integer",
          description: `Number of results to return (default ${DEFAULT_NUM_RESULTS}, values are truncated and clamped to ${MIN_NUM_RESULTS}–${MAX_NUM_RESULTS})`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export function describeValue(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(shorten(v, 60));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let json;
  try {
    json = JSON.stringify(v);
  } catch {
    json = undefined;
  }
  return `${Array.isArray(v) ? "array" : typeof v}${json ? ` ${shorten(json, 60)}` : ""}`;
}

export function parseNumResults(raw) {
  if (raw === undefined || raw === null) {
    return { value: DEFAULT_NUM_RESULTS, requested: DEFAULT_NUM_RESULTS, error: null };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      value: DEFAULT_NUM_RESULTS,
      requested: raw,
      error: `Invalid params: "numResults" must be a finite number, received ${describeValue(raw)}. Expected an integer between ${MIN_NUM_RESULTS} and ${MAX_NUM_RESULTS}.`,
    };
  }
  const truncated = Math.trunc(raw);
  return {
    value: Math.min(Math.max(truncated, MIN_NUM_RESULTS), MAX_NUM_RESULTS),
    requested: raw,
    error: null,
  };
}

export function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createMcpHandler({ config, engine, version = VERSION, send, log: logger = noop }) {
  const pendingCalls = new Map(); // JSON-RPC request id -> AbortController
  const serverInfo = { name: "websearch-ring", version };

  const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send(jsonRpcError(id, code, message));

  async function toolsCall(id, params, isNotification) {
    if (isNotification) {
      logger("ignoring tools/call without an id (notifications cannot be answered)");
      return;
    }
    const name = params?.name;
    if (name !== TOOL_NAME) {
      return fail(
        id,
        INVALID_PARAMS,
        `Invalid params: unknown tool ${describeValue(name)}. Available tools: ${TOOL_NAME}.`,
      );
    }
    if (config.errors.length) {
      return ok(id, { content: [{ type: "text", text: formatConfigError(config) }], isError: true });
    }
    const args = params?.arguments;
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      return fail(id, INVALID_PARAMS, `Invalid params: "arguments" must be an object, received ${describeValue(args)}.`);
    }
    const rawQuery = args?.query;
    if (typeof rawQuery !== "string" || !rawQuery.trim()) {
      return fail(id, INVALID_PARAMS, `Invalid params: "query" must be a non-empty string, received ${describeValue(rawQuery)}.`);
    }
    const query = rawQuery.trim();
    if (query.length > MAX_QUERY_CHARS) {
      return fail(id, INVALID_PARAMS, `Invalid params: "query" is ${query.length} characters long; the maximum is ${MAX_QUERY_CHARS}.`);
    }
    const parsed = parseNumResults(args?.numResults);
    if (parsed.error) return fail(id, INVALID_PARAMS, parsed.error);
    const count = parsed.value;
    if (parsed.requested !== count) logger(`numResults ${describeValue(parsed.requested)} adjusted to ${count}`);

    const controller = new AbortController();
    pendingCalls.set(id, controller);
    try {
      const result = await engine.search(query, count, { signal: controller.signal });
      return ok(id, {
        content: [{ type: "text", text: renderResult(result, { query, maxChars: config.maxChars }) }],
        isError: !result.vendor,
      });
    } catch (err) {
      // A cancelled request has no response by definition; the client moved on.
      if (isCancelled(err, controller.signal)) {
        logger(`request ${id} finished as cancelled — no response sent`);
        return;
      }
      logger(`tools/call ${id} failed: ${err?.stack || err}`);
      return ok(id, { content: [{ type: "text", text: `web_search failed: ${err?.message || err}` }], isError: true });
    } finally {
      if (pendingCalls.get(id) === controller) pendingCalls.delete(id);
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg || {};
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });

      case "server/discover":
        return ok(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo });

      case "notifications/initialized":
        return;

      case "notifications/cancelled": {
        const target = params?.requestId;
        const controller = pendingCalls.get(target);
        if (controller) {
          pendingCalls.delete(target);
          controller.abort(new CancelledError(`request ${target} cancelled by client`));
          logger(`request ${target} cancelled — aborting the in-flight search`);
        } else {
          logger(`ignoring cancel for request ${describeValue(target)} (not in flight)`);
        }
        return;
      }

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOLS });

      case "tools/call":
        return toolsCall(id, params, isNotification);

      default:
        if (isNotification) return;
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // Abort everything still in flight (used by tests/embedders; the stdio front
  // end deliberately does NOT call this on stdin EOF so one-shot pipes still get
  // their replies flushed).
  function abortAll(reason = "server shutting down") {
    const ids = [...pendingCalls.keys()];
    for (const id of ids) {
      const controller = pendingCalls.get(id);
      pendingCalls.delete(id);
      controller.abort(new CancelledError(`${reason} (request ${id})`));
    }
    return ids;
  }

  return { handle, pendingCalls, serverInfo, abortAll };
}

// ---------------------------------------------------------------- server

export function startServer({ env = process.env, input = process.stdin, output = process.stdout, logger = log } = {}) {
  const config = parseConfig(env);
  if (!config.ok) {
    logger("configuration error(s) detected:");
    for (const e of config.errors) logger(`  - ${e}`);
    logger("every tools/call will return this error instead of searching; other MCP methods still work.");
  } else {
    logger(
      `config: vendors=${config.vendors.join(" -> ")} timeoutMs=${config.timeoutMs} maxChars=${config.maxChars} ttlMs=${config.ttlMs} cacheMax=${config.cacheMax}`,
    );
  }

  const cache = createCache({ ttlMs: config.ttlMs, maxEntries: config.cacheMax, log: logger });
  if (config.ttlMs > 0) {
    const sweepMs = Math.min(Math.max(Math.floor(config.ttlMs / 4), 1000), 60_000);
    const timer = setInterval(() => {
      const removed = cache.sweep();
      if (removed) logger(`cache sweep removed ${removed} expired entries (entries ${cache.stats().size}/${config.cacheMax})`);
    }, sweepMs);
    // Never keep the process alive just to sweep the cache.
    timer.unref?.();
  }

  const engine = createSearchEngine({
    vendors: config.vendors,
    cache,
    timeoutMs: config.timeoutMs,
    exaApiKey: config.exaApiKey,
    tavilyApiKey: config.tavilyApiKey,
    ua: config.ua,
    log: logger,
  });
  const handler = createMcpHandler({
    config,
    engine,
    version: VERSION,
    send: (m) => output.write(`${JSON.stringify(m)}\n`),
    log: logger,
  });

  const rl = readline.createInterface({ input, terminal: false });
  const pending = new Set();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger("unparsable input line — replying with a JSON-RPC parse error");
      output.write(`${JSON.stringify(jsonRpcError(null, PARSE_ERROR, "Parse error: invalid JSON"))}\n`);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      logger("input line is not a JSON-RPC object — replying with an invalid-request error");
      output.write(`${JSON.stringify(jsonRpcError(null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC object"))}\n`);
      return;
    }
    const task = handler
      .handle(msg)
      .catch((err) => {
        logger(`handler error: ${err?.stack || err}`);
        if (msg?.id !== undefined && msg?.id !== null) {
          output.write(`${JSON.stringify(jsonRpcError(msg.id, INTERNAL_ERROR, String(err?.message || err)))}\n`);
        }
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  });

  // Clients that pipe input and close stdin immediately still need their replies
  // flushed, so wait for in-flight handlers instead of exiting at once.
  // Clients that pipe input and close stdin immediately (`... | node index.js`)
  // still need their replies flushed, so wait for in-flight handlers instead of
  // exiting (or aborting) at once.
  rl.on("close", () => {
    Promise.allSettled([...pending]).then(() => shutdown());
  });

  logger(`ready — vendors: ${config.vendors.join(" -> ")}`);
  return { config, cache, engine, handler };
}

// process.exit() while libuv still has a closing socket/DNS handle trips
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (uv_async_send) on
// Windows, so shut down gracefully: close the fetch dispatcher's keep-alive
// sockets, then let the event loop drain on its own.
async function shutdown({ exitCode = 0, backstopMs = 2000 } = {}) {
  process.exitCode = exitCode;
  try {
    const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
    if (dispatcher && typeof dispatcher.close === "function") await dispatcher.close();
  } catch {
    /* keep-alive sockets are best-effort: never block the shutdown */
  }
  // Hard backstop in case something else still refs the event loop.
  const backstop = setTimeout(() => process.exit(exitCode), backstopMs);
  backstop.unref?.();
}

// Start only when executed directly: importing this module (tests, embedding)
// must never spawn the stdio server.
export function isDirectInvocation(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return pathToFileURL(argv1).href === metaUrl;
  } catch {
    return false;
  }
}

export const invokedDirectly = isDirectInvocation();
if (invokedDirectly) startServer();
