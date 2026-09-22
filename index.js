#!/usr/bin/env node
// websearch-ring — MCP stdio server
//
// Multi-vendor web search with keyless-first rotation and automatic failover.
// Works in any MCP client (MiMo Desktop, Hermes, Claude Code, Cursor, ...).
//
// Env (all optional):
//   WEBSEARCH_VENDORS     comma list, default "exa,tavily,bing"
//   WEBSEARCH_TIMEOUT_MS  per-vendor timeout, default 12000
//   WEBSEARCH_MAX_CHARS   result text cap, default 12000
//   WEBSEARCH_TTL_MS      cache TTL, default 1200000 (0 disables)
//   EXA_API_KEY           optional; keyless public endpoint used when unset
//   TAVILY_API_KEY        optional; keyless access mode used when unset
//   WEBSEARCH_UA          User-Agent for the Bing vendor
//
// Outbound requests carry no user identifiers.

import readline from "node:readline";

const VENDORS = (process.env.WEBSEARCH_VENDORS || "exa,tavily,bing")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TIMEOUT_MS = Number(process.env.WEBSEARCH_TIMEOUT_MS || 12000);
const MAX_CHARS = Number(process.env.WEBSEARCH_MAX_CHARS || 12000);
const TTL_MS = Number(process.env.WEBSEARCH_TTL_MS ?? 1200000);
const UA =
  process.env.WEBSEARCH_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// stdout is the JSON-RPC channel — diagnostics must go to stderr only.
const log = (...a) => process.stderr.write(`[websearch-ring] ${a.join(" ")}\n`);

const FETCH_TIMEOUT_ERROR = "timeout";

// Vendors that answer a throttled request with HTTP 200 and a prose apology.
const RATE_LIMIT_RE =
  /rate limit|rate-limit|quota (?:exhausted|exceeded)|too many requests|usage limit|create your own .{0,18}api key|sign up for a free api key/i;

async function http(url, options, timeoutMs = TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(FETCH_TIMEOUT_ERROR);
    }
    throw err;
  }
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–",
  middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷",
};

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function clampSnippet(s, n = 400) {
  const clean = decodeEntities(s);
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

// ---------------------------------------------------------------- vendors

async function exa(query, count) {
  const url = process.env.EXA_API_KEY
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
    : "https://mcp.exa.ai/mcp";
  const res = await http(url, {
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
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  let text;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const parsed = JSON.parse(line.slice(6));
      const t = parsed?.result?.content?.[0]?.text;
      if (t) {
        text = t;
        break;
      }
    } catch {
      /* not a JSON frame; keep scanning */
    }
  }
  if (!text) throw new Error("empty response");

  const items = [];
  for (const block of text.split(/\n-{3,}\n/)) {
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
  if (items.length) return items;

  // Exa reports throttling and other refusals as a 200 with a prose body, so
  // surface those as failures and let the ring move on to the next vendor.
  if (RATE_LIMIT_RE.test(text)) throw new Error("rate limited");
  return [{ title: "Exa result", url: "", snippet: clampSnippet(text, 1200) }];
}

async function tavily(query, count) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.TAVILY_API_KEY) {
    headers.Authorization = `Bearer ${process.env.TAVILY_API_KEY}`;
  } else {
    headers["X-Tavily-Access-Mode"] = "keyless";
  }
  const res = await http("https://api.tavily.com/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, max_results: count }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = (data?.results || []).map((r) => ({
    title: decodeEntities(r.title || r.url || ""),
    url: r.url || "",
    snippet: clampSnippet(r.content || ""),
    score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : undefined,
  }));
  if (!items.length) throw new Error("no results");
  return items;
}

// Bing wraps some result links in a redirect; recover the real target.
function decodeBingUrl(href) {
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

async function bing(query, count) {
  const res = await http(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const items = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []) {
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
  if (!items.length) throw new Error("no results (page layout may have changed)");
  return items;
}

const REGISTRY = { exa, tavily, bing };

// ---------------------------------------------------------------- cache

const cache = new Map();
const inflight = new Map();

function cacheKey(query, count) {
  return `${query.trim().toLowerCase().replace(/\s+/g, " ")}::${count}`;
}

function cacheGet(key) {
  if (!TTL_MS) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (!TTL_MS) return;
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

// ---------------------------------------------------------------- search

async function runSearch(query, count) {
  const attempts = [];
  for (const name of VENDORS) {
    const vendor = REGISTRY[name];
    if (!vendor) {
      log(`unknown vendor in WEBSEARCH_VENDORS: ${name}`);
      continue;
    }
    try {
      const items = await vendor(query, count);
      const value = { vendor: name, items };
      cacheSet(cacheKey(query, count), value);
      return { ...value, cached: false, attempts };
    } catch (err) {
      attempts.push(`${name}: ${err.message}`);
      log(`vendor ${name} failed (${err.message}), trying next`);
    }
  }
  return { vendor: null, items: [], cached: false, attempts };
}

async function search(query, count) {
  const key = cacheKey(query, count);

  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  // Identical concurrent calls (subagent fan-outs) share one backend request.
  const pending = inflight.get(key);
  if (pending) return { ...(await pending), coalesced: true };

  const promise = runSearch(query, count);
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

function render(query, count, result) {
  if (!result.vendor) {
    return `All search vendors failed for "${query}".\nAttempts:\n- ${result.attempts.join("\n- ")}`;
  }
  const lines = [];
  const tag = result.cached ? ", cached" : result.coalesced ? ", shared with a concurrent call" : "";
  lines.push(`${result.items.length} results for "${query}" (via ${result.vendor}${tag})`);
  if (result.attempts.length) {
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
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n\n[TRUNCATED at ${MAX_CHARS} chars]`
    : text;
}

// ---------------------------------------------------------------- MCP

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web. Rotates across multiple keyless search backends with automatic failover, so it stays available regardless of which chat model or provider the client uses. Returns titles, URLs and snippets, and reports which backend served the result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        numResults: { type: "integer", description: "Number of results to return (default 8, max 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "websearch-ring", version: "1.0.0" },
      });

    case "server/discover":
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "websearch-ring", version: "1.0.0" },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== "web_search") {
        return ok(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
      }
      const query = String(args.query ?? "").trim();
      if (!query) {
        return ok(id, { content: [{ type: "text", text: "Missing required argument: query" }], isError: true });
      }
      const count = Math.min(Math.max(Number(args.numResults) || 8, 1), 20);
      try {
        const result = await search(query, count);
        return ok(id, {
          content: [{ type: "text", text: render(query, count, result) }],
          isError: !result.vendor,
        });
      } catch (err) {
        return ok(id, {
          content: [{ type: "text", text: `web_search failed: ${err?.message || err}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log("ignoring unparsable input line");
    return;
  }
  handle(msg).catch((err) => {
    log(`handler error: ${err?.stack || err}`);
    if (msg?.id !== undefined && msg?.id !== null) fail(msg.id, -32603, String(err?.message || err));
  });
});
rl.on("close", () => process.exit(0));

log(`ready — vendors: ${VENDORS.join(" -> ")}`);
