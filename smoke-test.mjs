// Smoke test: drives the MCP server over stdio and prints initialize / tools-list / one search.
// Run: node smoke-test.mjs "query"
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const server = spawn(process.execPath, [`${here}index.js`], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let out = "";
let err = "";
server.stdout.on("data", (d) => (out += d.toString()));
server.stderr.on("data", (d) => (err += d.toString()));

const send = (o) => server.stdin.write(`${JSON.stringify(o)}\n`);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const query = process.argv[2] || "nodejs latest version";
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "web_search", arguments: { query, numResults: 3 } },
});
// Repeat the identical call to confirm the cache path.
send({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "web_search", arguments: { query, numResults: 3 } },
});

setTimeout(() => {
  server.kill();
  console.log(`vendors env: ${process.env.WEBSEARCH_VENDORS || "(default)"}`);
  console.log("--- stderr ---");
  console.log(err.trim());
  console.log("--- stdout ---");
  for (const line of out.split("\n").filter(Boolean)) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      console.log("RAW:", line.slice(0, 200));
      continue;
    }
    if (m.id === 1) console.log("initialize ok:", JSON.stringify(m.result.serverInfo));
    else if (m.id === 2) console.log("tools:", m.result.tools.map((t) => t.name).join(","));
    else if (m.id === 3) console.log(`call isError=${m.result.isError}\n${m.result.content[0].text}`);
    else if (m.id === 4) {
      const head = m.result.content[0].text.split("\n")[0];
      console.log(`repeat call (cache check): ${head}`);
    } else console.log(line.slice(0, 200));
  }
  process.exit(0);
}, Number(process.env.WAIT_MS || 25000));
