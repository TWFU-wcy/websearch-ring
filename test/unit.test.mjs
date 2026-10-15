// Deterministic unit tests — no network, no subprocesses.
// Run: node --test test/unit.test.mjs   (or: npm test)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  NUMERIC_SPECS,
  VENDOR_NAMES,
  VERSION,
  buildRequestSignal,
  cacheKey,
  CancelledError,
  clampSnippet,
  codePointToString,
  createCache,
  createMcpHandler,
  createSearchEngine,
  decodeBingUrl,
  decodeEntities,
  describeValue,
  extractExaText,
  exa,
  bing,
  tavily,
  formatConfigError,
  http,
  INVALID_PARAMS,
  isCancelled,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  parseBingResults,
  parseConfig,
  parseExaItems,
  parseNumResults,
  parseTavilyResults,
  readPackageVersion,
  renderResult,
  isDirectInvocation,
  invokedDirectly,
  TIMEOUT_ERROR,
} from "../index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// ------------------------------------------------------------------ helpers

const makeRes = ({ status = 200, body = "", contentType = "application/json", payload } = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
    text: async () => text,
    json: async () => (payload !== undefined ? payload : JSON.parse(text)),
  };
};

const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
const contentFrame = (text, format = "sse") => {
  const msg = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } };
  return format === "sse" ? sse(msg) : JSON.stringify(msg);
};

const EXA_TEXT = [
  "Title: Node.js",
  "URL: https://nodejs.org/en",
  "Published: 2024-01-01",
  "",
  "Node.js is a JavaScript runtime built on Chrome's V8 engine.",
  "",
  "---",
  "",
  "Title: N/A",
  "URL: https://example.com/post?a=1&b=2",
  "",
  "# Example title line",
  "Some &amp; body text.",
].join("\n");

const collect = () => {
  const sent = [];
  return { sent, send: (m) => sent.push(m), log: () => {} };
};

const stubEngine = (impl) => ({ search: impl, stats: () => ({}) });

const baseConfig = (over = {}) => ({ ...parseConfig({}), ...over });

// ------------------------------------------------------------------ config

test("config: defaults when nothing is set", () => {
  const c = parseConfig({});
  assert.equal(c.ok, true);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.vendors, ["exa", "tavily", "bing"]);
  assert.equal(c.timeoutMs, 12000);
  assert.equal(c.maxChars, 12000);
  assert.equal(c.ttlMs, 1200000);
  assert.equal(c.cacheMax, 512);
  assert.equal(c.exaApiKey, null);
  assert.equal(c.tavilyApiKey, null);
  for (const name of Object.keys(NUMERIC_SPECS)) assert.equal(c.sources[name], "default", name);
});

test("config: every numeric variable rejects non-numbers, out-of-range and non-integers", () => {
  for (const [name, spec] of Object.entries(NUMERIC_SPECS)) {
    for (const bad of ["12s", "abc", "1.5", "0x10", "1e3", "Infinity", "NaN"]) {
      const c = parseConfig({ [name]: bad });
      assert.equal(c.ok, false, `${name}=${bad} should be rejected`);
      assert.equal(c.errors.length, 1);
      assert.match(c.errors[0], new RegExp(name));
      assert.match(c.errors[0], /not a valid number/);
      assert.equal(c.sources[name], "invalid");
    }
    const belowLow = spec.min - 1;
    if (belowLow >= Number.MIN_SAFE_INTEGER) {
      const c = parseConfig({ [name]: String(belowLow) });
      if (belowLow < 0 || spec.min - 1 !== spec.min) {
        assert.match(c.errors[0] ?? "", /out of range/, `${name}=${belowLow}`);
      }
    }
    const c = parseConfig({ [name]: String(spec.max + 1) });
    assert.equal(c.ok, false, `${name}=${spec.max + 1} should be rejected`);
    assert.match(c.errors[0], /out of range/);
    // invalid values fall back to the documented default: deterministic, not NaN
    assert.equal(c[name === "WEBSEARCH_MAX_CHARS" ? "maxChars" : name === "WEBSEARCH_TTL_MS" ? "ttlMs" : name === "WEBSEARCH_TIMEOUT_MS" ? "timeoutMs" : "cacheMax"], spec.def);
  }
});

test("config: S1 regression — WEBSEARCH_TIMEOUT_MS=12s yields a clear, caller-visible error", () => {
  const c = parseConfig({ WEBSEARCH_TIMEOUT_MS: "12s" });
  assert.equal(c.ok, false);
  assert.match(c.errors[0], /WEBSEARCH_TIMEOUT_MS="12s"/);
  assert.match(c.errors[0], /expected an integer between 1 and 600000/);
  assert.equal(Number.isFinite(c.timeoutMs), true);
  assert.equal(c.timeoutMs, 12000);
  const text = formatConfigError(c);
  assert.match(text, /misconfigured/);
  assert.match(text, /WEBSEARCH_TIMEOUT_MS="12s"/);
  assert.doesNotMatch(text, /All search vendors failed/);
});

test("config: empty string means 'unset' (default), 0 means 'disabled' for the TTL", () => {
  const empty = parseConfig({ WEBSEARCH_TTL_MS: "", WEBSEARCH_TIMEOUT_MS: "   " });
  assert.equal(empty.ok, true);
  assert.equal(empty.ttlMs, 1200000);
  assert.equal(empty.sources.WEBSEARCH_TTL_MS, "default");
  assert.equal(empty.timeoutMs, 12000);

  const zero = parseConfig({ WEBSEARCH_TTL_MS: "0" });
  assert.equal(zero.ok, true);
  assert.equal(zero.ttlMs, 0);
  assert.equal(zero.sources.WEBSEARCH_TTL_MS, "env");

  const small = parseConfig({ WEBSEARCH_CACHE_MAX: "   64  " });
  assert.equal(small.cacheMax, 64);
});

test("config: vendors are normalized, deduped and validated against the registry", () => {
  const norm = parseConfig({ WEBSEARCH_VENDORS: " EXA ,, tavily , EXA " });
  assert.equal(norm.ok, true);
  assert.deepEqual(norm.vendors, ["exa", "tavily"]);

  const single = parseConfig({ WEBSEARCH_VENDORS: "bing" });
  assert.deepEqual(single.vendors, ["bing"]);

  const blank = parseConfig({ WEBSEARCH_VENDORS: "   " });
  assert.equal(blank.ok, true);
  assert.deepEqual(blank.vendors, ["exa", "tavily", "bing"]);

  const nonsense = parseConfig({ WEBSEARCH_VENDORS: "nonsense" });
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.errors[0], /"nonsense"/);
  assert.match(nonsense.errors[0], /exa, tavily, bing/);

  const partial = parseConfig({ WEBSEARCH_VENDORS: "exa,qwant" });
  assert.equal(partial.ok, false);
  assert.match(partial.errors[0], /"qwant"/);
  assert.deepEqual(partial.vendors, ["exa"]);

  const commas = parseConfig({ WEBSEARCH_VENDORS: ",,," });
  assert.equal(commas.ok, false);
  assert.match(commas.errors[0], /selects no vendor/);
});

test("config: multiple problems are reported together", () => {
  const c = parseConfig({ WEBSEARCH_TIMEOUT_MS: "12s", WEBSEARCH_CACHE_MAX: "-1", WEBSEARCH_VENDORS: "nope" });
  assert.equal(c.errors.length, 3);
  const text = formatConfigError(c);
  assert.equal(text.split("\n").length, 4);
});

test("version: package.json is the single source of truth", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(readPackageVersion(), pkg.version);
  assert.equal(readPackageVersion("file:///nonexistent/index.js"), "0.0.0");
});

// ------------------------------------------------------------------ entities (G5)

test("G5: bogus numeric entities never throw and are preserved verbatim", () => {
  const nasty = "&#999999999; &#xFFFFFFFF; &#xD800; &#55296; &#1114112; &#x110000;";
  let out;
  assert.doesNotThrow(() => {
    out = decodeEntities(nasty);
  });
  assert.equal(out, "&#999999999; &#xFFFFFFFF; &#xD800; &#55296; &#1114112; &#x110000;");
  assert.equal(codePointToString(0x11ffff), null);
  assert.equal(codePointToString(Number.NaN), null);
  assert.equal(codePointToString(-1), null);
  assert.equal(codePointToString(0xdfff), null);
  assert.equal(codePointToString(65), "A");
});

test("G5: valid entities and tags still decode", () => {
  assert.equal(decodeEntities("&lt;b&gt;hi&lt;/b&gt; &amp; &#65;&#x4e2d; &hellip;"), "<b>hi</b> & A中 …");
  assert.equal(decodeEntities("<p>a   b</p>"), "a b");
  assert.equal(decodeEntities("&unknown;"), "&unknown;");
  assert.equal(clampSnippet("&#999999999; " + "x".repeat(50), 10), "&#99999999…");
  assert.equal(clampSnippet("short", 10), "short");
});

test("G5/G6: a poisoned entity in a vendor payload cannot fail the vendor", () => {
  const items = parseTavilyResults({
    results: [{ title: "Boom &#999999999; &#xD800;", url: "https://x.test", content: "body &#xD800; ok", score: 0.98765 }],
  });
  assert.equal(items[0].title, "Boom &#999999999; &#xD800;");
  assert.equal(items[0].score, 0.988);

  const html = `<li class="b_algo"><h2><a href="https://y.test/a">Bad &#999999999;</a></h2><p>snip &#xD800; text</p></li>`;
  const bingItems = parseBingResults(html, 5);
  assert.equal(bingItems.length, 1);
  assert.equal(bingItems[0].title, "Bad &#999999999;");
  assert.match(bingItems[0].snippet, /snip/);
});

test("bing redirect URLs are decoded, plain URLs pass through, junk is dropped", () => {
  const target = "https://example.com/real?x=1";
  const wrapped = `https://cn.bing.com/ck/a?u=a1${Buffer.from(target, "utf8").toString("base64url")}&ntb=1`;
  assert.equal(decodeBingUrl(wrapped), target);
  assert.equal(decodeBingUrl("https://plain.test/p"), "https://plain.test/p");
  assert.equal(decodeBingUrl("/relative/path"), null);
  assert.equal(decodeBingUrl(""), null);
});

// ------------------------------------------------------------------ exa parsing (G6)

test("G6: exa parses SSE frames", () => {
  const { text, format } = extractExaText(contentFrame(EXA_TEXT, "sse"));
  assert.equal(format, "sse");
  const items = parseExaItems(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Node.js");
  assert.equal(items[0].url, "https://nodejs.org/en");
  assert.equal(items[0].date, "2024-01-01");
  assert.match(items[0].snippet, /V8 engine/);
  // Title: N/A falls back to the first body line; entities are decoded
  assert.equal(items[1].title, "Example title line");
  assert.equal(items[1].snippet, "# Example title line Some & body text.");
});

test("G6: exa parses a plain JSON body too", () => {
  const { text, format } = extractExaText(contentFrame(EXA_TEXT, "json"));
  assert.equal(format, "json");
  assert.equal(parseExaItems(text).length, 2);
});

test("G6: failures distinguish 'format changed' from 'genuinely empty'", () => {
  assert.match(extractExaText("").detail, /empty/);
  const rpc = extractExaText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }));
  assert.equal(rpc.text, null);
  assert.match(rpc.detail, /upstream JSON-RPC error: boom/);
  assert.match(extractExaText("{not json").detail, /does not parse/);
  assert.match(extractExaText("<html>nope</html>").detail, /no SSE data frame/);
});

test("G6: exa vendor surfaces content-type + first bytes and rotates on", async () => {
  const html = makeRes({ body: "<html>upstream hiccup</html>", contentType: "text/html" });
  await assert.rejects(
    () => exa("q", 3, { fetchImpl: async () => html, timeoutMs: 12000 }),
    (err) => {
      assert.match(err.message, /no usable text/);
      assert.match(err.message, /content-type: text\/html/);
      assert.match(err.message, /upstream hiccup/);
      return true;
    },
  );

  const ok = makeRes({ body: contentFrame(EXA_TEXT, "json") });
  const items = await exa("q", 3, { fetchImpl: async () => ok, timeoutMs: 12000 });
  assert.equal(items.length, 2);
});

test("exa: throttling prose and prose-only answers", async () => {
  const limited = makeRes({ body: sse({ result: { content: [{ text: "You have hit your rate limit, create your own API key" }] } }) });
  await assert.rejects(() => exa("q", 3, { fetchImpl: async () => limited }), /rate limited/);

  const prose = makeRes({ body: sse({ result: { content: [{ text: "Just a normal sentence with no result blocks." }] } }) });
  const items = await exa("q", 3, { fetchImpl: async () => prose });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Exa result");
});

test("tavily/bing vendors parse realistic bodies", async () => {
  const tv = makeRes({
    payload: { results: [{ title: "T &amp; T", url: "https://t.test", content: "hello <b>world</b>", score: 0.5 }] },
  });
  const tvItems = await tavily("q", 3, { fetchImpl: async () => tv });
  assert.equal(tvItems[0].title, "T & T");
  assert.equal(tvItems[0].snippet, "hello world");

  await assert.rejects(
    () => tavily("q", 3, { fetchImpl: async () => makeRes({ payload: { results: [] } }) }),
    /no results/,
  );

  const bingHtml = `<ol><li class="b_algo"><h2><a href="https://b.test/1">B &amp; B</a></h2><p>snip</p></li></ul>`;
  const bingItems = await bing("q", 3, { fetchImpl: async () => makeRes({ body: bingHtml, contentType: "text/html" }) });
  assert.equal(bingItems.length, 1);
  assert.equal(bingItems[0].title, "B & B");
  assert.equal(bingItems[0].url, "https://b.test/1");

  await assert.rejects(
    () => bing("q", 3, { fetchImpl: async () => makeRes({ body: "<html></html>", contentType: "text/html" }) }),
    /no results \(page layout may have changed\)/,
  );
});

// ------------------------------------------------------------------ cache (S2)

test("S2: cache is capacity-bounded and evicts least-recently-used entries", () => {
  const logs = [];
  const cache = createCache({ ttlMs: 60_000, maxEntries: 3, log: (m) => logs.push(m) });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 1); // refresh "a": "b" is now the oldest
  cache.set("d", 4);
  assert.equal(cache.get("b"), null, "oldest entry must be evicted");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
  assert.equal(cache.stats().size, 3);
  assert.equal(cache.stats().evictions, 1);
  assert.match(logs[0], /evicted least-recently-used/);
});

test("S2: inserting thousands of distinct queries keeps the cache bounded", () => {
  const cache = createCache({ ttlMs: 60_000, maxEntries: 256 });
  for (let i = 0; i < 5000; i += 1) cache.set(cacheKey(`query number ${i}`, 8), { vendor: "exa", items: [] });
  const s = cache.stats();
  assert.equal(s.size, 256);
  assert.equal(s.max, 256);
  assert.equal(s.evictions, 5000 - 256);
  assert.ok(s.size <= s.max);
  // 5000 * ~8KB would be ~40MB unbounded; the cap is what keeps it flat
  console.log(`    cache stats after 5000 distinct queries: ${JSON.stringify(s)}`);
});

test("S2: expiry is enforced on access and by the sweeper (no unref'd timer needed here)", () => {
  let clock = 1_000_000;
  const cache = createCache({ ttlMs: 1000, maxEntries: 10, now: () => clock });
  cache.set("k", "v");
  clock += 999;
  assert.equal(cache.get("k"), "v");
  clock += 2; // now beyond expiresAt
  assert.equal(cache.get("k"), null);
  assert.equal(cache.stats().expired, 1);

  cache.set("a", 1);
  cache.set("b", 2);
  clock += 5000;
  assert.equal(cache.sweep(), 2);
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.stats().swept, 2);
});

test("S2: TTL 0 disables the cache entirely (no writes, no hits)", () => {
  const cache = createCache({ ttlMs: 0, maxEntries: 10 });
  cache.set("k", "v");
  assert.equal(cache.get("k"), null);
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.stats().enabled, false);
  assert.equal(cache.sweep(), 0);
});

// ------------------------------------------------------------------ engine

test("S4: the second identical call is served from the cache without touching upstream", async () => {
  let calls = 0;
  const logs = [];
  const cache = createCache({ ttlMs: 60_000, maxEntries: 8 });
  const engine = createSearchEngine({
    cache,
    vendors: ["exa"],
    registry: { exa: async () => { calls += 1; return [{ title: "t", url: "u", snippet: "s" }]; } },
    log: (m) => logs.push(m),
  });

  const first = await engine.search("Hello  World", 3);
  assert.equal(first.cached, false);
  assert.equal(first.vendor, "exa");
  assert.deepEqual(first.attempts, []);

  const second = await engine.search("hello world", 3); // same key after normalization
  assert.equal(second.cached, true);
  assert.equal(second.vendor, "exa");
  assert.deepEqual(second.attempts, []);
  assert.equal(calls, 1, "upstream must be hit exactly once");
  assert.equal(cache.stats().hits, 1);
  assert.ok(logs.some((l) => /cache hit for/.test(l)), "cache hits must be observable on stderr");
  assert.equal(logs.filter((l) => /vendor exa served/.test(l)).length, 1);

  assert.match(renderResult(second, { query: "hello world" }).split("\n")[0], /\(via exa, cached\)$/);
});

test("concurrent identical calls are coalesced into one upstream request", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const cache = createCache({ ttlMs: 60_000, maxEntries: 8 });
  const engine = createSearchEngine({
    cache,
    vendors: ["exa"],
    registry: {
      exa: async () => {
        calls += 1;
        await gate;
        return [{ title: "t", url: "u", snippet: "s" }];
      },
    },
  });
  const [a, b] = await Promise.all([engine.search("same query", 3), (async () => { release(); return engine.search("same query", 3); })()]);
  release();
  assert.equal(calls, 1);
  assert.equal(a.coalesced, undefined);
  assert.equal(b.coalesced, true);
  assert.match(renderResult(b, { query: "same query" }).split("\n")[0], /shared with a concurrent call/);
});

test("G11: cancelling a request aborts upstream and never populates the cache", async () => {
  let started = 0;
  let sawAbort = false;
  const cache = createCache({ ttlMs: 60_000, maxEntries: 8 });
  const engine = createSearchEngine({
    cache,
    vendors: ["exa"],
    registry: {
      exa: (q, c, ctx) =>
        new Promise((_resolve, reject) => {
          started += 1;
          ctx.signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new CancelledError());
            },
            { once: true },
          );
        }),
    },
  });

  const controller = new AbortController();
  const pending = engine.search("hang", 3, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(pending, (err) => isCancelled(err) && err.name === "CancelledError");
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(started, 1);
  assert.equal(sawAbort, true, "upstream must observe the abort");
  assert.equal(cache.has(cacheKey("hang", 3)), false, "a cancelled search must not be cached");
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.stats().hits, 0);
  assert.equal(engine.stats().inflight, 0, "inflight bookkeeping must be cleaned up");
});

test("the vendor ring reports every attempt when all vendors fail", async () => {
  const engine = createSearchEngine({
    cache: createCache({ ttlMs: 60_000, maxEntries: 8 }),
    vendors: ["exa", "tavily"],
    registry: {
      exa: async () => { throw new Error("HTTP 500"); },
      tavily: async () => { throw new Error("timeout"); },
    },
  });
  const result = await engine.search("q", 3);
  assert.equal(result.vendor, null);
  assert.deepEqual(result.attempts, ["exa: HTTP 500", "tavily: timeout"]);
  assert.equal(engine.stats().size, 0, "a failed search must not be cached");
  const text = renderResult(result, { query: "q" });
  assert.match(text, /All search vendors failed for "q"/);
  assert.match(text, /- exa: HTTP 500\n- tavily: timeout/);
});

test("timeouts are reported as timeouts and the ring moves on", async () => {
  const timeoutErr = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const engine = createSearchEngine({
    cache: createCache({ ttlMs: 0, maxEntries: 4 }),
    vendors: ["exa", "tavily"],
    fetchImpl: async (url) => {
      if (url.includes("exa")) throw timeoutErr;
      return makeRes({ payload: { results: [{ title: "t", url: "u", content: "c" }] } });
    },
  });
  const result = await engine.search("q", 3);
  assert.equal(result.vendor, "tavily");
  assert.deepEqual(result.attempts, [`exa: ${TIMEOUT_ERROR}`]);
});

test("S1: an invalid timeout can never reach AbortSignal.timeout (no NaN demotion)", async () => {
  assert.throws(() => buildRequestSignal(Number.NaN, null), /invalid timeout/);
  assert.throws(() => buildRequestSignal(0, null), /invalid timeout/);
  assert.throws(() => buildRequestSignal(12000.5, null), /invalid timeout/);
  assert.ok(buildRequestSignal(12000, null) instanceof AbortSignal);
  await assert.rejects(() => http("https://x.test", {}, { timeoutMs: Number.NaN }), /refusing to send request/);
});

test("S1: a validated legal timeout is wired into the request as a real timeout signal", async () => {
  const cfg = parseConfig({ WEBSEARCH_TIMEOUT_MS: "25" });
  assert.equal(cfg.timeoutMs, 25);
  let seenSignal;
  const engine = createSearchEngine({
    cache: createCache({ ttlMs: 0, maxEntries: 2 }),
    vendors: ["exa"],
    timeoutMs: cfg.timeoutMs,
    fetchImpl: async (_url, options) => {
      seenSignal = options.signal;
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    },
  });
  const result = await engine.search("slow", 3);
  assert.ok(seenSignal instanceof AbortSignal, "the vendor request must carry a timeout signal");
  assert.equal(seenSignal.aborted, false, "a legal timeout must not abort the request up front");
  assert.deepEqual(result.attempts, [`exa: ${TIMEOUT_ERROR}`]);
  assert.equal(result.vendor, null);
});

test("S1: the validated timeout deadline really fires", async () => {
  const signal = buildRequestSignal(25, null);
  // AbortSignal.timeout() uses an *unref'd* timer, so a promise waiting only on
  // it can be dropped when the event loop drains (Node 20's test runner aborts
  // the file in that case). Keep the loop ref'd for the duration of this test.
  const fired = await new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(true), { once: true });
    setTimeout(() => resolve(signal.aborted), 1000);
  });
  assert.equal(fired, true);
  assert.equal(signal.reason?.name, "TimeoutError");
});

test("abort beats a same-tick timeout: a cancelled request is never reported as a vendor failure", async () => {
  const controller = new AbortController();
  const engine = createSearchEngine({
    cache: createCache({ ttlMs: 0, maxEntries: 2 }),
    vendors: ["exa"],
    fetchImpl: async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  await assert.rejects(() => engine.search("q", 3, { signal: controller.signal }), (err) => isCancelled(err));
});

test("the engine's cache stays bounded across many distinct queries", async () => {
  const engine = createSearchEngine({
    cache: createCache({ ttlMs: 60_000, maxEntries: 8 }),
    vendors: ["exa"],
    registry: { exa: async (q) => [{ title: q, url: "", snippet: "" }] },
  });
  for (let i = 0; i < 40; i += 1) await engine.search(`distinct ${i}`, 1);
  assert.equal(engine.stats().size, 8);
  assert.equal(engine.stats().max, 8);
});

// ------------------------------------------------------------------ render

test("render: format, tags, note line, truncation and the empty-attempts error (G11)", () => {
  const items = [{ title: "T", url: "https://u.test", snippet: "s" }];
  const normal = renderResult({ vendor: "bing", items, attempts: [] }, { query: "q" });
  assert.equal(normal.split("\n")[0], '1 results for "q" (via bing)');
  assert.match(normal, /1\. T\n   https:\/\/u\.test\n   s/);

  const cached = renderResult({ vendor: "bing", items, attempts: [], cached: true }, { query: "q" });
  assert.match(cached.split("\n")[0], /\(via bing, cached\)$/);

  const coalesced = renderResult({ vendor: "bing", items, attempts: [], coalesced: true }, { query: "q" });
  assert.match(coalesced.split("\n")[0], /\(via bing, shared with a concurrent call\)$/);

  const withNote = renderResult({ vendor: "bing", items, attempts: ["exa: timeout"] }, { query: "q" });
  assert.match(withNote, /Note: earlier vendors failed and were skipped — exa: timeout/);

  const truncated = renderResult({ vendor: "bing", items, attempts: [] }, { query: "q", maxChars: 10 });
  assert.equal(truncated, '1 results \n\n[TRUNCATED at 10 chars]');

  const dead = renderResult({ vendor: null, items: [], attempts: [] }, { query: "q" });
  assert.match(dead, /No search vendor could run for "q"/);
  assert.match(dead, /WEBSEARCH_VENDORS/);
  assert.match(dead, /exa, tavily, bing/);
  assert.doesNotMatch(dead, /Attempts:\n- $/);
});

// ------------------------------------------------------------------ handler

const callHandler = async (handler, msg) => {
  await handler.handle(msg);
};

const toolsCall = (handler, id, args, name = "web_search") =>
  callHandler(handler, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("handler: initialize / server-discover / ping / tools-list basics", async () => {
  const { sent, send, log } = collect();
  const handler = createMcpHandler({ config: baseConfig(), engine: stubEngine(async () => ({ vendor: "exa", items: [], attempts: [] })), send, log });
  await callHandler(handler, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  assert.equal(sent[0].id, 1);
  assert.equal(sent[0].result.serverInfo.name, "websearch-ring");
  assert.equal(sent[0].result.serverInfo.version, pkg.version);
  assert.equal(sent[0].result.protocolVersion, "2024-11-05");

  await callHandler(handler, { jsonrpc: "2.0", id: 2, method: "server/discover" });
  assert.equal(sent[1].result.serverInfo.version, pkg.version);

  await callHandler(handler, { jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(sent[2].result, {});

  await callHandler(handler, { jsonrpc: "2.0", id: 4, method: "tools/list" });
  const tool = sent[3].result.tools.find((t) => t.name === "web_search");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["query"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.numResults.type, "integer");

  // notifications never get a reply
  await callHandler(handler, { jsonrpc: "2.0", method: "notifications/initialized" });
  await callHandler(handler, { jsonrpc: "2.0", method: "some/other/notification" });
  assert.equal(sent.length, 4);
});

test("handler: error paths use correct JSON-RPC codes", async () => {
  const { sent, send, log } = collect();
  const handler = createMcpHandler({ config: baseConfig(), engine: stubEngine(async () => ({ vendor: "exa", items: [], attempts: [] })), send, log });

  await callHandler(handler, { jsonrpc: "2.0", id: 1, method: "nope/method" });
  assert.equal(sent[0].error.code, METHOD_NOT_FOUND);
  assert.match(sent[0].error.message, /Method not found: nope\/method/);

  await toolsCall(handler, 2, { query: "q" }, "other_tool");
  assert.equal(sent[1].error.code, INVALID_PARAMS);
  assert.match(sent[1].error.message, /unknown tool "other_tool"/);

  await toolsCall(handler, 3, {});
  assert.equal(sent[2].error.code, INVALID_PARAMS);
  assert.match(sent[2].error.message, /"query" must be a non-empty string, received undefined/);

  await toolsCall(handler, 4, { query: "   " });
  assert.match(sent[3].error.message, /non-empty string/);

  await toolsCall(handler, 5, { query: "q".repeat(1001) });
  assert.equal(sent[4].error.code, INVALID_PARAMS);
  assert.match(sent[4].error.message, /is 1001 characters long; the maximum is 1000/);

  await toolsCall(handler, 6, { query: "q", numResults: "3" });
  assert.equal(sent[5].error.code, INVALID_PARAMS);
  assert.match(sent[5].error.message, /"numResults" must be a finite number, received "3"/);

  await toolsCall(handler, 7, "not-an-object");
  assert.match(sent[6].error.message, /"arguments" must be an object/);

  await callHandler(handler, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "web_search", arguments: { query: "q", numResults: Number.NaN } } });
  assert.match(sent[7].error.message, /received NaN/);

  // PARSE_ERROR is produced by the stdio layer, not the handler
  assert.equal(PARSE_ERROR, -32700);
});

test("G7: numResults is truncated and clamped instead of silently defaulted", async () => {
  const { sent, send, log } = collect();
  const seen = [];
  const engine = stubEngine(async (_q, count) => {
    seen.push(count);
    return { vendor: "exa", items: [], attempts: [] };
  });
  const handler = createMcpHandler({ config: baseConfig(), engine, send, log });

  await toolsCall(handler, 1, { query: "q", numResults: 3.7 });
  await toolsCall(handler, 2, { query: "q2", numResults: 0 });
  await toolsCall(handler, 3, { query: "q3", numResults: 99 });
  await toolsCall(handler, 4, { query: "q4", numResults: -5 });
  await toolsCall(handler, 5, { query: "q5" });
  await toolsCall(handler, 6, { query: "q6", numResults: "4" });
  assert.deepEqual(seen, [3, 1, 20, 1, 8]);
  assert.equal(sent[5].error.code, INVALID_PARAMS, "a string must be rejected, not coerced");

  assert.deepEqual(parseNumResults(undefined), { value: 8, requested: 8, error: null });
  assert.equal(parseNumResults(2.999).value, 2);
  assert.equal(Number.isInteger(parseNumResults(7.5).value), true);
  assert.equal(describeValue([1, 2]), "array [1,2]");
  assert.equal(describeValue(undefined), "undefined");
  assert.equal(describeValue(null), "null");
  assert.equal(describeValue(true), "true");
  assert.match(describeValue({ a: 1 }), /^object /);
});

test("handler: a misconfigured server answers tools/call with the configuration error (S1)", async () => {
  const config = parseConfig({ WEBSEARCH_TIMEOUT_MS: "12s", WEBSEARCH_CACHE_MAX: "lots" });
  const { sent, send, log } = collect();
  let searched = false;
  const handler = createMcpHandler({
    config,
    engine: stubEngine(async () => {
      searched = true;
      return { vendor: "exa", items: [], attempts: [] };
    }),
    send,
    log,
  });

  await callHandler(handler, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(sent[0].result.serverInfo.version, pkg.version, "initialize must still work");

  await toolsCall(handler, 2, { query: "q" });
  assert.equal(sent[1].result.isError, true);
  assert.match(sent[1].result.content[0].text, /WEBSEARCH_TIMEOUT_MS="12s"/);
  assert.match(sent[1].result.content[0].text, /WEBSEARCH_CACHE_MAX="lots"/);
  assert.doesNotMatch(sent[1].result.content[0].text, /All search vendors failed/);
  assert.equal(searched, false, "no vendor may run while the configuration is broken");

  // G11: an all-unknown vendor list is a configuration error that names the legal range
  const vendors = parseConfig({ WEBSEARCH_VENDORS: "nonsense" });
  const cfg2 = parseConfig({ WEBSEARCH_VENDORS: "nonsense" });
  assert.equal(vendors.ok, false);
  assert.match(formatConfigError(cfg2), /valid names are exa, tavily, bing/);
});

test("handler: success and total-failure results", async () => {
  const { sent, send, log } = collect();
  const good = createMcpHandler({
    config: baseConfig(),
    engine: stubEngine(async () => ({ vendor: "exa", items: [{ title: "T", url: "u", snippet: "s" }], attempts: [] })),
    send,
    log,
  });
  await toolsCall(good, 1, { query: "q" });
  assert.equal(sent[0].result.isError, false);
  assert.match(sent[0].result.content[0].text, /^1 results for "q" \(via exa\)/);

  const bad = createMcpHandler({
    config: baseConfig(),
    engine: stubEngine(async () => ({ vendor: null, items: [], attempts: ["exa: HTTP 503"] })),
    send,
    log,
  });
  await toolsCall(bad, 2, { query: "q" });
  assert.equal(sent[1].result.isError, true);
  assert.match(sent[1].result.content[0].text, /All search vendors failed/);

  const boom = createMcpHandler({
    config: baseConfig(),
    engine: stubEngine(async () => {
      throw new Error("unexpected");
    }),
    send,
    log,
  });
  await toolsCall(boom, 3, { query: "q" });
  assert.equal(sent[2].result.isError, true);
  assert.match(sent[2].result.content[0].text, /web_search failed: unexpected/);
});

test("G11: notifications/cancelled aborts the in-flight call and sends no reply", async () => {
  const { sent, send, log } = collect();
  let aborted = false;
  let sawSignal;
  const engine = stubEngine(
    (_q, _c, { signal }) =>
      new Promise((_resolve, reject) => {
        sawSignal = signal;
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new CancelledError());
          },
          { once: true },
        );
      }),
  );
  const handler = createMcpHandler({ config: baseConfig(), engine, send, log });

  const inflight = toolsCall(handler, 9, { query: "hang" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(handler.pendingCalls.has(9), true);

  await callHandler(handler, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  await inflight;

  assert.equal(aborted, true, "the engine must see the abort");
  assert.equal(sawSignal.aborted, true);
  assert.deepEqual(sent, [], "a cancelled request must not produce a response");
  assert.equal(handler.pendingCalls.has(9), false, "bookkeeping must be cleaned up");

  // cancelling something that is not in flight is harmless
  await callHandler(handler, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4242 } });
  await callHandler(handler, { jsonrpc: "2.0", method: "notifications/cancelled" });
  assert.deepEqual(sent, []);
});

test("handler: a tools/call without an id is ignored instead of answering with id null", async () => {
  const { sent, send, log } = collect();
  const handler = createMcpHandler({ config: baseConfig(), engine: stubEngine(async () => ({ vendor: "exa", items: [], attempts: [] })), send, log });
  await callHandler(handler, { jsonrpc: "2.0", method: "tools/call", params: { name: "web_search", arguments: { query: "q" } } });
  assert.deepEqual(sent, []);
});

test("handler: abortAll cancels every registered in-flight call", async () => {
  const { sent, send, log } = collect();
  const aborted = [];
  const engine = stubEngine(
    (q, _c, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(q);
            reject(new CancelledError());
          },
          { once: true },
        );
      }),
  );
  const handler = createMcpHandler({ config: baseConfig(), engine, send, log });
  const a = toolsCall(handler, 11, { query: "one" });
  const b = toolsCall(handler, 12, { query: "two" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(handler.pendingCalls.size, 2);
  assert.deepEqual(handler.abortAll("stdin closed"), [11, 12]);
  await Promise.all([a, b]);
  assert.deepEqual(aborted.sort(), ["one", "two"]);
  assert.deepEqual(sent, [], "aborted calls must not be answered");
  assert.equal(handler.pendingCalls.size, 0);
  assert.deepEqual(handler.abortAll(), []);
});

test("G8: importing index.js has no side effects", () => {
  assert.equal(invokedDirectly, false);
  assert.equal(isDirectInvocation(), false);
  assert.equal(isDirectInvocation(undefined), false);
  const selfUrl = new URL("../index.js", import.meta.url);
  assert.equal(isDirectInvocation(fileURLToPath(selfUrl), selfUrl.href), true);
  assert.equal(isDirectInvocation("C:\\elsewhere\\index.js", selfUrl.href), false);
});
