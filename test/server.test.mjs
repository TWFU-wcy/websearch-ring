// Process-level tests: spawn the real stdio MCP server and assert on the exact
// JSON-RPC bytes. No network access is required — every case is either a
// protocol/validation error or a request that is cancelled before it completes.
// Run: node --test test/server.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  cancelNotification,
  cleanEnv,
  delay,
  INDEX,
  INDEX_URL,
  initRequest,
  startServer,
  StdioClient,
  toolsCallRequest,
} from "./stdio-client.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const assertCleanStdout = (client) => {
  assert.deepEqual(client.unparsable, [], "stdout must carry JSON-RPC frames only");
};

test("S1: WEBSEARCH_TIMEOUT_MS=12s reaches the caller as a configuration error", async () => {
  const client = startServer({ WEBSEARCH_TIMEOUT_MS: "12s" });
  try {
    client.send(initRequest(1));
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    client.send(toolsCallRequest(3, { query: "anything" }));

    const init = await client.reply(1);
    assert.equal(init.result.serverInfo.name, "websearch-ring");
    assert.equal(init.result.serverInfo.version, pkg.version, "version must come from package.json (G9)");
    assert.equal(init.result.protocolVersion, "2024-11-05");

    const list = await client.reply(2);
    assert.ok(list.result.tools.some((t) => t.name === "web_search"), "tools/list must still work while misconfigured");

    const call = await client.reply(3);
    const text = call.result.content[0].text;
    assert.equal(call.result.isError, true);
    assert.match(text, /misconfigured/);
    assert.match(text, /WEBSEARCH_TIMEOUT_MS="12s"/);
    assert.match(text, /expected an integer between 1 and 600000/);
    assert.doesNotMatch(text, /All search vendors failed/, "the config error must not be swallowed by the vendor ring");

    assert.match(client.stderr, /configuration error\(s\) detected/);
    assert.match(client.stderr, /WEBSEARCH_TIMEOUT_MS="12s"/);
    assertCleanStdout(client);

    const { code } = await client.close();
    assert.equal(code, 0);
  } finally {
    client.kill();
  }
});

test("G11: WEBSEARCH_VENDORS=nonsense names the legal values instead of printing a dangling list", async () => {
  const client = startServer({ WEBSEARCH_VENDORS: "nonsense" });
  try {
    client.send(initRequest(1));
    await client.reply(1);
    client.send(toolsCallRequest(2, { query: "anything" }));
    const call = await client.reply(2);
    const text = call.result.content[0].text;
    assert.equal(call.result.isError, true);
    assert.match(text, /WEBSEARCH_VENDORS="nonsense"/);
    assert.match(text, /valid names are exa, tavily, bing/);
    assert.doesNotMatch(text, /Attempts:\n- *$/);
    assertCleanStdout(client);
    await client.close();
  } finally {
    client.kill();
  }
});

test("a legal configuration starts normally and answers protocol-level errors correctly", async () => {
  const client = startServer({ WEBSEARCH_TIMEOUT_MS: "12000", WEBSEARCH_TTL_MS: "60000", WEBSEARCH_CACHE_MAX: "64" });
  try {
    assert.match(await client.waitFor((_m, s) => /ready — vendors: exa -> tavily -> bing/.test(s) && s, { label: "ready line" }), /ready/);
    assert.match(client.stderr, /config: vendors=exa -> tavily -> bing timeoutMs=12000 maxChars=12000 ttlMs=60000 cacheMax=64/);
    assert.doesNotMatch(client.stderr, /configuration error/);

    client.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.deepEqual((await client.reply(1)).result, {});

    client.send({ jsonrpc: "2.0", id: 2, method: "totally/unknown" });
    const unknown = await client.reply(2);
    assert.equal(unknown.error.code, -32601);
    assert.match(unknown.error.message, /Method not found: totally\/unknown/);

    // malformed JSON must produce a spec-compliant parse error with id null
    client.write('{"jsonrpc":"2.0","id":99,\n');
    const parseErr = await client.waitFor((msgs) => msgs.find((m) => m.id === null && m.error), { label: "parse error reply" });
    assert.equal(parseErr.error.code, -32700);

    client.send(toolsCallRequest(3, {}));
    const missing = await client.reply(3);
    assert.equal(missing.error.code, -32602);
    assert.match(missing.error.message, /"query" must be a non-empty string, received undefined/);

    client.send(toolsCallRequest(4, { query: "q", numResults: "abc" }));
    const badCount = await client.reply(4);
    assert.equal(badCount.error.code, -32602);
    assert.match(badCount.error.message, /"numResults" must be a finite number, received "abc"/);

    client.send(toolsCallRequest(5, { query: "x".repeat(1001) }));
    const tooLong = await client.reply(5);
    assert.equal(tooLong.error.code, -32602);
    assert.match(tooLong.error.message, /the maximum is 1000/);

    // notifications must never be answered
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "web_search", arguments: { query: "q" } } });
    await delay(200);
    assert.equal(client.messages.length, 6, `unexpected extra replies: ${client.raw.join(" | ")}`);

    assertCleanStdout(client);
    const { code } = await client.close();
    assert.equal(code, 0);
  } finally {
    client.kill();
  }
});

test("G11: a real notifications/cancelled aborts the in-flight call over stdio", async () => {
  const client = startServer({ WEBSEARCH_VENDORS: "exa", WEBSEARCH_TIMEOUT_MS: "60000", WEBSEARCH_TTL_MS: "0" });
  try {
    client.send(initRequest(1));
    await client.reply(1);

    // One write: the cancel is read in the same stdin chunk, so it always beats
    // the (async) network round-trip and the test stays deterministic offline.
    client.write(`${JSON.stringify(toolsCallRequest(77, { query: "hang forever" }))}\n${JSON.stringify(cancelNotification(77))}\n`);

    await client.waitFor((_m, s) => /request 77 cancelled — aborting the in-flight search/.test(s), {
      label: "cancellation log",
    });
    await delay(400);

    assert.equal(client.messages.some((m) => m.id === 77), false, "a cancelled request must not get a reply");
    assert.doesNotMatch(client.stderr, /vendor exa served/, "the aborted search must not reach the cache/upstream log");
    assertCleanStdout(client);

    // and the server exits promptly instead of waiting for the abandoned request
    const { code } = await client.close({ timeout: 5000 });
    assert.equal(code, 0);
  } finally {
    client.kill();
  }
});

test("G8: importing index.js does not start a server", async () => {
  const child = spawn(process.execPath, ["-e", `import(${JSON.stringify(INDEX_URL)}).then(() => console.log("IMPORT_OK"))`], {
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv(),
  });
  const client = new StdioClient(child);
  const { code } = await client.close({ timeout: 10000 });
  assert.equal(code, 0, client.stderr);
  assert.match(client.raw.join("\n"), /IMPORT_OK/);
  assert.doesNotMatch(client.stderr, /ready — vendors/);
  assert.deepEqual(client.unparsable, ["IMPORT_OK"], "an import must not write JSON-RPC frames to stdout");
});

test("G8: running index.js directly does start the server", async () => {
  const child = spawn(process.execPath, [INDEX], { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
  const client = new StdioClient(child);
  try {
    await client.waitFor((_m, s) => /ready — vendors/.test(s), { label: "startup banner" });
    client.send(initRequest(1));
    const init = await client.reply(1);
    assert.equal(init.result.serverInfo.version, pkg.version);
    await client.close();
  } finally {
    client.kill();
  }
});

test("stdin EOF still flushes replies for piped one-shot input and exits cleanly", async () => {
  const client = startServer({ WEBSEARCH_TIMEOUT_MS: "12000" });
  try {
    // Written in a single chunk, then stdin is closed immediately: the replies
    // must still come back (and the process must not abort on exit).
    client.write(
      `${JSON.stringify(initRequest(1))}\n${JSON.stringify(toolsCallRequest(2, { query: "q", numResults: "abc" }))}\n`,
    );
    const startedAt = Date.now();
    const { code } = await client.close({ timeout: 15000 });
    assert.equal(code, 0, `shutdown crashed: ${client.stderr}`);
    assert.ok(Date.now() - startedAt < 10000, "shutdown must not hang");
    assert.equal(client.messages.length, 2, `replies were dropped: ${client.raw.join(" | ")}`);
    assert.equal((await client.reply(1)).result.serverInfo.version, pkg.version);
    assert.equal((await client.reply(2)).error.code, -32602);
  } finally {
    client.kill();
  }
});
