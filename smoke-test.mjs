// Smoke test: drives the real MCP server over stdio and *asserts* on every reply.
//
//   node smoke-test.mjs ["query"]            full: protocol + validation + real search + cache
//   node smoke-test.mjs --offline ["query"]  no network: protocol + validation + cancellation
//
// Exit code is 0 only when every assertion passed; failures print the reason.
// The network-dependent part is the `full` mode (default). CI runs `--offline`
// in the blocking job and the full run in a separate, non-blocking job.
//
// Env: SMOKE_QUERY (query), WAIT_MS (search timeout, default 30000)
import { readFileSync } from "node:fs";

import { cancelNotification, initRequest, startServer, toolsCallRequest } from "./test/stdio-client.mjs";

const args = process.argv.slice(2);
const offline = args.includes("--offline") || process.env.SMOKE_MODE === "offline";
const query = args.find((a) => !a.startsWith("--")) || process.env.SMOKE_QUERY || "nodejs latest version";
const waitMs = Number(process.env.WAIT_MS || 30000);

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, reason: err.message });
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
};

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

console.log(`websearch-ring smoke test — mode=${offline ? "offline (no network)" : "full (hits the real backends)"} query="${query}"`);
const client = startServer();
let networkFailure = null;

try {
  // ---------------------------------------------------------------- protocol
  client.send(initRequest(1));
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const init = await client.reply(1);
  check("initialize: id, serverInfo name/version (from package.json), protocol echo", () => {
    assert(init.jsonrpc === "2.0", `jsonrpc must be "2.0", got ${JSON.stringify(init.jsonrpc)}`);
    assert(init.id === 1, `response id must match the request id, got ${JSON.stringify(init.id)}`);
    assert(init.error === undefined, `initialize returned an error: ${JSON.stringify(init.error)}`);
    assert(init.result?.serverInfo?.name === "websearch-ring", `unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`);
    assert(init.result.serverInfo.version === pkg.version, `serverInfo.version ${init.result.serverInfo.version} !== package.json ${pkg.version}`);
    assert(init.result.protocolVersion === "2024-11-05", `unexpected protocolVersion ${init.result.protocolVersion}`);
  });

  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await client.reply(2);
  check("tools/list: web_search with the documented input schema", () => {
    const tool = list.result?.tools?.find((t) => t.name === "web_search");
    assert(tool, `web_search missing from ${JSON.stringify(list.result?.tools?.map((t) => t.name))}`);
    assert(tool.description.length > 20, "tool description must be non-empty");
    assert(tool.inputSchema?.properties?.query?.type === "string", "query must be a string property");
    assert(tool.inputSchema?.properties?.numResults?.type === "integer", "numResults must be declared integer");
    assert(JSON.stringify(tool.inputSchema.required) === '["query"]', "query must be the only required argument");
    assert(tool.inputSchema.additionalProperties === false, "additionalProperties must be false");
  });

  // ---------------------------------------------------------------- error paths
  client.write('{"jsonrpc":"2.0","id":900,\n');
  const parseErr = await client.waitFor((msgs) => msgs.find((m) => m.id === null && m.error), { label: "parse error reply" });
  check("malformed JSON: -32700 Parse error with id null", () => {
    assert(parseErr.error.code === -32700, `expected -32700, got ${JSON.stringify(parseErr.error)}`);
  });

  client.send({ jsonrpc: "2.0", id: 3, method: "definitely/not/a/method" });
  const unknown = await client.reply(3);
  check("unknown method: -32601 Method not found", () => {
    assert(unknown.error?.code === -32601, `expected -32601, got ${JSON.stringify(unknown)}`);
  });

  client.send(toolsCallRequest(4, {}));
  const missing = await client.reply(4);
  check("tools/call without query: -32602 Invalid params", () => {
    assert(missing.error?.code === -32602, `expected -32602, got ${JSON.stringify(missing)}`);
    assert(/"query" must be a non-empty string/.test(missing.error.message), `unexpected message: ${missing.error.message}`);
  });

  client.send(toolsCallRequest(5, { query, numResults: "three" }));
  const badCount = await client.reply(5);
  check("tools/call with a non-numeric numResults: -32602 Invalid params", () => {
    assert(badCount.error?.code === -32602, `expected -32602, got ${JSON.stringify(badCount)}`);
    assert(/numResults/.test(badCount.error.message), `unexpected message: ${badCount.error.message}`);
  });

  // ---------------------------------------------------------------- cancellation
  client.write(`${JSON.stringify(toolsCallRequest(6, { query: "cancel me" }))}\n${JSON.stringify(cancelNotification(6))}\n`);
  await client.waitFor((_m, err) => /request 6 cancelled — aborting the in-flight search/.test(err), { label: "cancellation log" });
  await new Promise((r) => setTimeout(r, 300));
  check("notifications/cancelled: request aborted, no reply sent", () => {
    assert(!client.messages.some((m) => m.id === 6), "a cancelled request must not produce a reply");
  });

  // ---------------------------------------------------------------- real search + cache
  if (!offline) {
    let first;
    try {
      client.send(toolsCallRequest(7, { query, numResults: 3 }));
      first = await client.reply(7, { timeout: waitMs });
    } catch (err) {
      networkFailure = err.message;
    }

    if (first?.result?.isError) {
      networkFailure = first.result.content[0].text;
    }

    check("tools/call: JSON-RPC shape and content[0].text", () => {
      assert(first, `no reply within ${waitMs}ms: ${networkFailure || ""}`);
      assert(first.id === 7, `response id mismatch: ${JSON.stringify(first.id)}`);
      assert(!first.error, `unexpected JSON-RPC error: ${JSON.stringify(first.error)}`);
      assert(Array.isArray(first.result?.content), "result.content must be an array");
      assert(first.result.content[0]?.type === "text", "content[0].type must be text");
      assert(typeof first.result.content[0].text === "string" && first.result.content[0].text.trim(), "content[0].text must be non-empty");
    });

    check(`search returned real results (backend reachable)`, () => {
      assert(!first?.result?.isError, `search failed: ${first?.result?.content?.[0]?.text || networkFailure}`);
      assert(/^\d+ results for ".+" \(via (exa|tavily|bing)\)$/.test(first.result.content[0].text.split("\n")[0]), `unexpected first line: ${first.result.content[0].text.split("\n")[0]}`);
    });

    if (first && !first.result.isError) {
      const upstreamBefore = (client.stderr.match(/vendor \w+ served/g) || []).length;
      client.send(toolsCallRequest(8, { query, numResults: 3 }));
      const second = await client.reply(8, { timeout: waitMs });
      check("identical repeat call is served from the cache (S4)", () => {
        const head = second.result.content[0].text.split("\n")[0];
        assert(/^\d+ results for ".+" \(via (exa|tavily|bing), cached\)$/.test(head), `expected a ", cached" tag, got: ${head}`);
        const upstreamAfter = (client.stderr.match(/vendor \w+ served/g) || []).length;
        assert(upstreamAfter === upstreamBefore, `upstream was called again: ${upstreamBefore} -> ${upstreamAfter}`);
        assert(/cache hit for/.test(client.stderr), "the cache hit must be visible on stderr");
      });
    } else {
      results.push({ name: "identical repeat call is served from the cache (S4)", ok: false, reason: "skipped: the first search never succeeded" });
      console.log("  FAIL identical repeat call is served from the cache (S4)\n       skipped: the first search never succeeded");
    }
  }

  // ---------------------------------------------------------------- protocol hygiene
  check("stdout carried JSON-RPC frames only", () => {
    assert(client.unparsable.length === 0, `non-JSON lines on stdout: ${JSON.stringify(client.unparsable)}`);
  });

  const { code } = await client.close();
  check("server exits cleanly on stdin EOF", () => {
    assert(code === 0, `exit code ${code}`);
  });
} catch (err) {
  results.push({ name: "harness", ok: false, reason: err.message });
  console.log(`  FAIL harness\n       ${err.message}`);
} finally {
  client.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (client.stderr.trim()) {
  console.log("--- server stderr (diagnostics) ---");
  console.log(client.stderr.trim());
}
if (offline) {
  console.log("offline mode: protocol, validation and cancellation only — no network request was made");
} else if (networkFailure) {
  console.log(`network note: the search itself did not succeed on this host (${String(networkFailure).split("\n")[0]})`);
}
if (failed.length) {
  console.log(`\nFAILED (${failed.length}):`);
  for (const f of failed) console.log(`- ${f.name}: ${String(f.reason).split("\n")[0]}`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
