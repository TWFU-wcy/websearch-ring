// Shared stdio client for the process-level tests (spawn the real MCP server).
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INDEX = fileURLToPath(new URL("../index.js", import.meta.url));
export const INDEX_URL = pathToFileURL(INDEX).href;

// Deterministic env: whatever the developer's shell has set must not leak in.
export function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("WEBSEARCH_") || key === "EXA_API_KEY" || key === "TAVILY_API_KEY") delete env[key];
  }
  return { ...env, ...overrides };
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class StdioClient {
  constructor(child) {
    this.child = child;
    this.messages = [];
    this.raw = [];
    this.unparsable = [];
    this.stderr = "";
    this.exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        this.raw.push(line);
        try {
          this.messages.push(JSON.parse(line));
        } catch {
          this.unparsable.push(line);
          this.messages.push({ __unparsable: line });
        }
      }
    });
    child.stderr.on("data", (d) => {
      this.stderr += d.toString();
    });
  }

  write(text) {
    this.child.stdin.write(text);
  }

  send(msg) {
    this.write(`${JSON.stringify(msg)}\n`);
  }

  async waitFor(predicate, { timeout = 5000, label = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = predicate(this.messages, this.stderr);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${timeout}ms waiting for ${label}\n--- stdout ---\n${this.raw.join("\n")}\n--- stderr ---\n${this.stderr}`,
        );
      }
      await delay(10);
    }
  }

  reply(id, { timeout = 5000 } = {}) {
    return this.waitFor((msgs) => msgs.find((m) => m.id === id), { timeout, label: `reply with id=${id}` });
  }

  async close({ timeout = 5000 } = {}) {
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill(), timeout);
    const result = await this.exit;
    clearTimeout(killer);
    return result;
  }

  kill() {
    this.child.kill();
  }
}

export function startServer(overrides = {}) {
  const child = spawn(process.execPath, [INDEX], { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv(overrides) });
  return new StdioClient(child);
}

export const initRequest = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
});

export const toolsCallRequest = (id, args, name = "web_search") => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

export const cancelNotification = (requestId) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId },
});
