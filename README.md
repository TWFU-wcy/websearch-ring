# websearch-ring

**多后端轮询 · 自动故障转移 · Keyless 优先** 的网页搜索 MCP Server。

一份 `index.js`，零 npm 依赖，接到任意 MCP 客户端（**Claude Code、Codex、Cursor、Windsurf、VS Code**，以及 MiMo Desktop、Hermes 等）即可让 Agent 稳定联网搜索——不绑模型、不绑厂商、不强制 API Key。

```text
3 results for "杭州周末天气" (via exa, cached)
1. 杭州天气预报…
   https://…
```

首行永远标明 **实际由哪家提供**（`via exa` / `tavily` / `bing`），以及是否命中缓存（`, cached`）或被并发合并（`, shared with a concurrent call`）。

---

## 为什么需要它

| 痛点 | websearch-ring 的做法 |
|------|------------------------|
| 单一搜索 API 挂了 / 限流 | 按环顺序自动换下一家 |
| 不想管一堆 API Key | 默认 keyless 通道开箱即用 |
| 同样 query 被子代理打爆 | TTL 缓存 + 相同并发请求合并 |
| 出站带用户标识 | **请求不携带任何用户标识** |
| 换模型后内置 websearch 不可用 / 烧插件额度 | 独立 stdio MCP，客户端无关 |

---

## 特性

- ✅ **厂商轮盘**：默认 `exa → tavily → bing`，失败 / 超时 / 限流记入 `attempts` 后自动 failover
- ✅ **Keyless 优先**：Exa、Tavily 支持无 Key 模式；可选 `EXA_API_KEY` / `TAVILY_API_KEY` 提额度
- ✅ **TTL 缓存**：`cacheKey = 小写query::count`，默认 20 分钟（`WEBSEARCH_TTL_MS`）
- ✅ **并发合并**：相同 query 并发只打一次后端（inflight coalescing）
- ✅ **可审计返回**：via 来源 + 失败 attempts + 截断标记
- ✅ **单文件**：核心约 400 行，无构建、无 dependencies
- ✅ **隐私**：出站请求无用户标识

---

## 快速开始

### 1. 运行冒烟测试（可选）

```bash
node smoke-test.mjs "杭州周末天气"
```

预期 stdout 中有：

- `initialize ok` / `tools: web_search`
- 第一次 `call isError=false`，首行 **不含** `cached`
- 第二次相同 call，首行含 **`(via …, cached)`**

### 2. 接入 MCP 客户端

下面把 **Claude Code / Codex / Cursor** 等主流工具放在前面；MiMo、Hermes 作为补充示例在文末。  
路径请改成你机器上的绝对路径（Windows 可用 `C:/...` 或 `C:\\...`）。

公共环境变量（可按需删减）：

```json
{
  "WEBSEARCH_VENDORS": "exa,tavily,bing",
  "WEBSEARCH_TIMEOUT_MS": "12000",
  "WEBSEARCH_TTL_MS": "1200000",
  "WEBSEARCH_MAX_CHARS": "12000"
}
```

#### Claude Code

**方式 A — CLI（推荐）**

```bash
claude mcp add websearch-ring -- node /absolute/path/to/websearch-ring/index.js
```

需要带环境变量时：

```bash
claude mcp add websearch-ring \
  -e WEBSEARCH_VENDORS=exa,tavily,bing \
  -e WEBSEARCH_TIMEOUT_MS=12000 \
  -- node /absolute/path/to/websearch-ring/index.js
```

**方式 B — 项目配置** `.mcp.json`（与项目根目录同级）

```json
{
  "mcpServers": {
    "websearch-ring": {
      "command": "node",
      "args": ["/absolute/path/to/websearch-ring/index.js"],
      "env": {
        "WEBSEARCH_VENDORS": "exa,tavily,bing",
        "WEBSEARCH_TIMEOUT_MS": "12000",
        "WEBSEARCH_TTL_MS": "1200000",
        "WEBSEARCH_MAX_CHARS": "12000"
      }
    }
  }
}
```

用户级则写入 `~/.claude.json` 的 `mcpServers`（或用 `claude mcp add --scope user …`）。

#### Codex CLI

编辑 `~/.codex/config.toml`（Windows：`%USERPROFILE%\.codex\config.toml`）：

```toml
[mcp_servers.websearch-ring]
command = "node"
args = ["/absolute/path/to/websearch-ring/index.js"]

[mcp_servers.websearch-ring.env]
WEBSEARCH_VENDORS = "exa,tavily,bing"
WEBSEARCH_TIMEOUT_MS = "12000"
WEBSEARCH_TTL_MS = "1200000"
WEBSEARCH_MAX_CHARS = "12000"
```

重启 Codex 会话后，工具会以 `websearch-ring` 服务器暴露的 `web_search` 出现。

#### Cursor

项目级 `.cursor/mcp.json`，或用户级 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "websearch-ring": {
      "command": "node",
      "args": ["/absolute/path/to/websearch-ring/index.js"],
      "env": {
        "WEBSEARCH_VENDORS": "exa,tavily,bing",
        "WEBSEARCH_TIMEOUT_MS": "12000",
        "WEBSEARCH_TTL_MS": "1200000",
        "WEBSEARCH_MAX_CHARS": "12000"
      }
    }
  }
}
```

在 Cursor **Settings → MCP** 中应能看到该 server 与 `web_search` 工具。

#### Windsurf

`~/.codeium/windsurf/mcp_config.json`（或 IDE 内 MCP 设置），结构同上：`mcpServers.websearch-ring`。

#### VS Code（Copilot / Chat MCP）

工作区 `.vscode/mcp.json`（较新格式用 `servers` 键）：

```json
{
  "servers": {
    "websearch-ring": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/websearch-ring/index.js"],
      "env": {
        "WEBSEARCH_VENDORS": "exa,tavily,bing",
        "WEBSEARCH_TIMEOUT_MS": "12000"
      }
    }
  }
}
```

若你的 VS Code 版本仍用 `mcpServers`，改键名即可，内容不变。

#### 通用 `mcpServers` JSON（Claude Desktop 等）

Claude Desktop：`claude_desktop_config.json`  
（Windows：`%APPDATA%\Claude\claude_desktop_config.json`；macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "websearch-ring": {
      "command": "node",
      "args": ["/absolute/path/to/websearch-ring/index.js"],
      "env": {
        "WEBSEARCH_VENDORS": "exa,tavily,bing",
        "WEBSEARCH_TIMEOUT_MS": "12000",
        "WEBSEARCH_TTL_MS": "1200000",
        "WEBSEARCH_MAX_CHARS": "12000"
      }
    }
  }
}
```

改完需 **完全退出并重启** Claude Desktop。

#### 其它客户端

只要支持 **stdio + JSON-RPC MCP**，形式都是：

```text
command: node
args:    [/absolute/path/to/websearch-ring/index.js]
env:     见上表
```

#### 补充：MiMo Desktop / MiMoCode

合并 `mimo-mcp-snippet.jsonc` 中的 `mcp` / `tools` / `permission` 片段到  
`~/.config/mimocode/mimocode.jsonc`（路径以你的机器为准），然后**新开会话或重启引擎**（MCP 不热加载）。

要点：

- server 名可用 `searchring`，避免与内置工具撞名
- **`timeout` 建议 ≥ 30000**（默认 5000ms 会截断轮转）
- 可用 `tools.websearch: false` + `permission.websearch: "deny"` 关掉内置 websearch，避免烧平台联网额度

#### 补充：Hermes

见 `hermes-mcp-snippet.yaml`（顶层键为 `mcp_servers`）。

---

## 环境变量（全部可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `WEBSEARCH_VENDORS` | `exa,tavily,bing` | 轮转顺序，逗号分隔 |
| `WEBSEARCH_TIMEOUT_MS` | `12000` | 单厂商超时 |
| `WEBSEARCH_MAX_CHARS` | `12000` | 返回文本上限 |
| `WEBSEARCH_TTL_MS` | `1200000` | 缓存 TTL；`0` 关闭 |
| `EXA_API_KEY` | （空） | 空则走 Exa keyless |
| `TAVILY_API_KEY` | （空） | 空则走 Tavily keyless |
| `WEBSEARCH_UA` | Chrome UA | Bing 抓取用 User-Agent |

---

## 调用流程

```text
tools/call web_search
        │
        ▼
  参数校验（query 必填，numResults ∈ 1–20）
        │
        ▼
  TTL 缓存命中？ ──是──► 返回 (via …, cached)
        │否
        ▼
  同一 query 正在跑？ ──是──► 共享那一次请求 (shared with a concurrent call)
        │否
        ▼
  轮转环: Exa → 失败/限流 → Tavily → 失败 → Bing
        │成功
        ▼
  写入缓存 → render()（标注 via + 上限截断）→ JSON-RPC 返回
        │全失败
        ▼
  返回每家失败原因（isError=true）
```

---

## 工具接口

**Tool:** `web_search`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅ | 搜索词 |
| `numResults` | integer | | 条数，默认 8，钳制 1–20 |

**成功首行示例**

```text
3 results for "杭州周末天气" (via exa)
8 results for "MCP protocol" (via tavily, cached)
5 results for "foo" (via bing, shared with a concurrent call)
```

---

## 与同类方案的差异

GitHub 上已有多引擎搜索 MCP（failover / 聚合 / rerank）。websearch-ring 的切口是：

1. **最轻**：单文件、零依赖，不是 8 引擎平台
2. **Keyless-first**，可选补 Key
3. **缓存 + 并发合并** 同时具备（很多只做 failover）
4. **via / attempts 透明**，便于审计「到底谁在搜」

定位一句话：

> **最轻量的高可用搜索环：一份 index.js，exa→tavily→bing 自动故障转移 + TTL 缓存 + 并发合并。**

---

## 许可证

MIT
