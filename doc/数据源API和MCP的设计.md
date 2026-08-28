# 数据源管理：API 与 MCP 数据源接入

## 背景与范围

现状：`DataSource.type` 枚举已含 `api / mcp / browser`，但连接器、路由动作、UI 仅实现了 `bi`（PostgreSQL）与 `web`。本期实现：

1. **API 数据源**：请求外部开放平台 API，支持 REST 与 GraphQL 两种协议，含认证配置、连接测试、请求调试台、GraphQL Schema 内省
2. **MCP 数据源**：经内部 MCP 代理（streamable HTTP）连接第三方 MCP 服务，基于 `@langchain/mcp-adapters` + LangGraph `createReactAgent` 实现工具发现、单工具调试与 ReAct Agent 调试
3. **Agent 接入**：深度研究 Worker 可调用已注册的 API / MCP 数据源

**浏览器抓取（browser）本期不做**（用户已确认）：纯 Web 页面应用下服务端 Playwright 无头运行，需要用户交互登录（扫码/验证码）的站点只能靠 Cookie 导入或远程 screencast 登录，两者体验均不佳。`browser` 枚举保留，注册接口对该类型返回 400「暂不支持」。

无 Prisma 迁移：类型特有配置全部存入现有 `DataSource.config`（Json）。

## 依赖

- 新增 `@langchain/mcp-adapters`（与现有 `@langchain/core` 1.x / `@langchain/langgraph` 1.x 兼容）

## 配置模型（存入 DataSource.config）

```ts
// api 类型
interface ApiSourceConfig {
  endpoint: string;                  // REST base URL 或 GraphQL endpoint
  protocol: "rest" | "graphql";
  authType: "none" | "bearer" | "api_key" | "basic";
  authToken?: string;                // bearer/basic 凭证或 api key 值（仅存库，接口永不回显）
  apiKeyHeader?: string;             // api_key 时 header 名，默认 X-API-Key
  headers?: Record<string, string>;  // 额外自定义 header
}
// mcp 类型
interface McpSourceConfig {
  proxyUrl: string;                  // 内部 MCP 代理 streamable HTTP 地址
  headers?: Record<string, string>;  // 访问代理所需 header（如内部鉴权）
}
```

## 后端改动

### 1. 新连接器 `lib/server/connectors/api.ts`

- `buildAuthHeaders(config)`：按 authType 组装请求头
- `testApiSource(config)`：GraphQL → POST `{ query: "{ __typename }" }`；REST → GET endpoint（status < 500 即视为可达），返回 `{ ok, latencyMs, statusCode, error? }`
- `executeRestRequest(config, { method, path, params?, body? })`：仅允许 GET/POST；path 拼接到 endpoint（校验不允许换 host）；超时 15s；响应体截断至 200KB；返回 `{ status, contentType, body, elapsedMs, truncated }`
- `executeGraphQLQuery(config, { query, variables? })`：**只读防护**——解析首个操作关键字，拒绝 `mutation`/`subscription`；返回 `{ data, errors, elapsedMs }`
- `introspectGraphQLSchema(config)`：标准 introspection 查询，整理为 Query 根字段列表 `[{ name, description, args: [{name,type}], returnType }]`（截断至前 80 个字段），供控制台与 Agent 提示词使用
- 安全：endpoint 仅允许 http/https

### 2. 新连接器 `lib/server/connectors/mcp.ts`

- `withMcpClient(config, fn)`：创建 `MultiServerMCPClient`（transport `http`，开启 SSE 自动回退，传入 config.headers），`finally` 中 `close()`
- `listMcpTools(config)`：返回 `[{ name, description, inputSchema }]`
- `callMcpTool(config, toolName, args)`：直接调用单个工具，结果 stringify 并截断至 50KB
- `runMcpReactAgent(config, task)`：`createReactAgent({ llm: getChatModel({ temperature: 0 }), tools: mcp工具 })`，`recursionLimit: 25`，流式收集中间步骤，返回 `{ answer, steps: [{ tool, input, output, elapsedMs }] }`

### 3. 数据源注册/解析 `lib/server/connectors/datasources.ts`

- `ResolvedDataSource` 增加类型化 `config` 字段（union）；`listDataSources` / `resolveDataSource` 解析 api/mcp 配置
- status 判定：api → 有 endpoint 即 active；mcp → 有 proxyUrl 即 active
- 列表脱敏：api/mcp 的 endpoint/proxyUrl 走 `maskUrl`；`authToken`、`headers` 值永不返回前端

### 4. 路由 `app/api/v1/datasources/route.ts`

- `CreateDataSourceSchema` 按 type 分支校验（zod discriminated union 或 superRefine）：
  - `api`：`endpoint`(url) + `protocol` 必填，auth 字段可选
  - `mcp`：`proxyUrl`(url) 必填
  - `browser`：返回 400「浏览器抓取数据源暂不支持」
- GET 列表为 api 源附带 `meta: { protocol }`（前端按协议渲染控制台）

### 5. 路由 `app/api/v1/datasources/[id]/[action]/route.ts` 新增动作

| 动作 | 方法 | 适用类型 | 说明 |
|---|---|---|---|
| `test` | POST | api / mcp（扩展现有分支） | api → testApiSource；mcp → 连接并返回工具数 |
| `request` | POST | api(rest) | body: `{ method, path, params?, body? }` |
| `graphql` | POST | api(graphql) | body: `{ query, variables? }`，只读校验 |
| `schema` | GET | api(graphql)（扩展现有分支） | GraphQL introspection 结果 |
| `tools` | GET | mcp | MCP 工具列表 |
| `invoke` | POST | mcp | body: `{ tool, args }` 单工具调试 |
| `agent` | POST | mcp | body: `{ task }` ReAct Agent 执行，返回 `{ answer, steps }`，`maxDuration` 提到 120 |

### 6. 新路由 `app/api/v1/datasources/[id]/route.ts`

- `DELETE`：删除自定义数据源（builtin 返回 403）——管理台配套能力

## Agent 接入（深度研究 Worker）

### `lib/server/agents/tools.ts` 新增两个工具（沿用现有 ctx.sink 事件模式）

- `createApiSourceTool(ctx, sources)` → 工具名 `query_api_source`：schema `{ sourceId, path?, method?, params?, body?, graphqlQuery?, variables? }`，按源 protocol 分发到 REST/GraphQL 连接器；description 动态枚举已注册 API 源（名称/ID/协议/脱敏 endpoint）；预算：单次任务最多 6 次调用
- `createMcpSourceTool(ctx, sources)` → 工具名 `query_mcp_source`：schema `{ sourceId, task }`，内部执行 `runMcpReactAgent`（子 ReAct Agent），中间步骤经 `ctx.sink` 推送；预算：单次任务最多 3 次调用

### `lib/server/agents/workers.ts`

- `runResearchWorker` 启动时查询自定义 api/mcp 数据源（`listDataSources()` 过滤 `!builtin && status==="active"`），非空时：把两个工具加入 tools 数组，并在 RESEARCHER_PROMPT 后追加「## 已接入的外部数据源」小节（源列表 + 使用建议），无注册源时行为与现在完全一致

## 前端改动 `app/(dashboard)/datasources/client.tsx`

### 注册表单 `CreateSourceForm`

- 增加类型选择（PostgreSQL / API 接口 / MCP 代理），按类型渲染字段：
  - API：endpoint、协议（REST/GraphQL）、认证方式下拉 + 凭证输入、自定义 header（KV 文本）
  - MCP：代理地址、header（KV 文本）

### 详情区按类型渲染

- **api 面板**：连接测试（复用现有 section，展示 status/latency）＋ 请求调试台：
  - REST：method（GET/POST）+ path + params/body（JSON textarea）→ 响应以格式化 JSON 展示（`<pre>`，含 status/耗时/截断标记）
  - GraphQL：query 编辑框 + variables JSON + 「浏览 Schema」按钮（展示 Query 根字段列表，点击字段可插入查询骨架）
- **mcp 面板**：连接测试 ＋ 工具列表（名称/描述/参数 schema，点击填充调用表单）＋ 单工具调用（args JSON → 结果展示）＋ ReAct Agent 调试框（输入自然语言任务 → 展示步骤时间线 + 最终回答）
- 列表卡片：api 用 `Webhook` 图标、mcp 用 `Bot` 图标（lucide），类型标签相应显示「API 接口 / MCP 代理」；自定义源增加删除按钮（confirm 后调 DELETE）

## 测试计划

1. `npm run typecheck`、`npm run lint`、`npm run test` 全部通过
2. 新增 vitest 单测：GraphQL 只读防护（mutation 拒绝）、REST path 拼接不允许跨 host、注册接口分类型校验（api 缺 endpoint / mcp 缺 proxyUrl / browser 拒绝）
3. `npm run dev` 手动验证：注册 GraphQL 公共 API（如 countries.trevorblades.com）跑通测试/内省/查询；注册 REST API 跑通请求台；MCP 需内部代理地址，无环境时验证连接失败提示是否友好

## 假设与说明

- MCP 代理为 streamable HTTP 传输（自动回退 SSE），鉴权通过自定义 header 传递；如内部代理是纯 SSE 或 stdio，仅需调 transport 配置
- API/GraphQL 调用坚持只读原则：REST 限 GET/POST（POST 面向 GraphQL 及查询类开放平台接口），GraphQL 拒绝 mutation/subscription
- 凭证以明文存于 `data_sources.config`（与现有 bi 连接串一致的处理方式），接口层全部脱敏，不额外引入加密存储
- DataAnalystWorker 不接入外部源（保持职责单一），仅 ResearchWorker 接入；后续需要时同法扩展