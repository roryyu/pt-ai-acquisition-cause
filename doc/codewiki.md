# 归因模块（pt-ai-acquisition-cause）代码库架构 Wiki

> 本文档基于源码只读调查生成，所有结论均可回链到具体文件与行号。
> 最后更新：2026-08-27

---

## 1. 项目定位与技术栈

### 1.1 项目定位

归因模块是面向企业内部的数据驱动决策工具，核心能力包括：

- **自然语言问答**：用户用中文提问，系统自动路由到直接回答 / 数据分析 / 深度研究三条路径
- **深度研究**：Planner 拆解子问题 → 逐子问题检索与深读 → 多源交叉比对 → 流式成稿
- **洞察画布**：基于 tldraw 的无限画布，整合原报告 / 看板 / 日报三模块，支持实时数据绑定
- **数据源接入**：内置演示 PG 库 + 互联网检索，自定义支持 BI(PostgreSQL) / API(REST/GraphQL) / MCP
- **算子层**：数据分析算子（SQL 引擎）+ 研究算子（LLM 引擎）统一注册
- **定时投递**：对洞察文档执行定时邮件 / 图片导出，由外部 cron 驱动

### 1.2 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 框架 | Next.js (App Router) | 16.3.2 | `package.json:52` |
| 运行时 | React | 19.2.8 | `package.json:54` |
| 语言 | TypeScript (strict) | 5.9.3 | `tsconfig.json` |
| 样式 | Tailwind CSS v4 | 4.3.3 | `@tailwindcss/postcss` |
| ORM | Prisma + @prisma/adapter-pg | 7.9.1 (exact) | `package.json:35-36` |
| 验证 | Zod | 4.4.3 | 所有外部输入校验 |
| 状态 | Zustand + SWR | 5.0.15 / 2.5.1 | 客户端状态 / 数据请求 |
| AI 编排 | LangGraph | 1.4.12 | Supervisor 多 Agent 状态图 |
| AI 模型 | OpenAI SDK (兼容协议) | 7.5.0 | 统一模型网关 |
| 图表 | Recharts | 3.10.1 | Agent 生成图表前端渲染 |
| 画布 | tldraw | 5.3.2 | 洞察画布编辑器 |
| 拖拽 | @dnd-kit | 6.3.1 | 看板卡片拖拽（预留） |
| 测试 | Vitest | 4.1.11 | 单元测试 |
| Node.js | 24.7.0 | `package.json:8` | nvm 管理 |

---

## 2. 目录结构总览

```
pt-ai-acquisition-cause/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # 工作台路由组（侧边栏+顶栏布局）
│   │   ├── layout.tsx            # 工作台布局
│   │   ├── sidebar.tsx           # 侧边栏导航（客户端）
│   │   ├── topbar.tsx            # 顶栏搜索/通知（客户端）
│   │   ├── page.tsx              # 工作台首页
│   │   ├── ask/                  # 任务问答（流式 AI 回答）
│   │   ├── research/             # 深度研究
│   │   ├── insights/             # 洞察画布（列表+详情+画布编辑器）
│   │   ├── datasources/          # 数据源管理
│   │   ├── semantic/             # 语义层管理
│   │   └── operators/            # 算子管理
│   ├── api/v1/                   # REST API（全部路由见 §4）
│   ├── login/                    # 登录页（开发桩）
│   ├── layout.tsx                # 根布局
│   └── globals.css               # 设计系统 CSS 变量
├── lib/
│   ├── server/                   # 服务端核心（仅服务端可导入）
│   │   ├── agents/               # Agent 系统（见 §5）
│   │   ├── connectors/           # 数据源连接器（见 §6）
│   │   ├── operators/            # 算子层（见 §7）
│   │   ├── semantic/             # 语义层（见 §8）
│   │   ├── insights/             # 洞察画布服务（见 §9）
│   │   ├── delivery/             # 投递服务（见 §10）
│   │   ├── api-runtime.ts        # 统一 API 运行时
│   │   ├── model-gateway.ts      # 统一模型网关（主备降级）
│   │   ├── sse.ts                # SSE 流式响应工具
│   │   ├── scheduler.ts          # 定时任务调度器
│   │   ├── ids.ts                # ID 生成（prefix_uuid）
│   │   └── user.ts               # 用户相关
│   ├── db/                       # Prisma 客户端
│   │   ├── index.ts              # Prisma Client 单例
│   │   └── generated/client/     # Prisma 生成代码
│   ├── env.ts                    # 环境变量 Zod 校验
│   ├── utils.ts                  # cn() 类名合并
│   ├── agent-events.ts           # Agent 事件类型（前端复用）
│   └── canvas/types.ts           # 画布类型
├── components/                   # 前端组件
│   ├── agent/                    # AgentTimeline / MarkdownView
│   ├── canvas/                   # 画布相关组件
│   ├── charts/                   # ChartRenderer（Recharts）
│   ├── data/                     # DataTable
│   └── logo-icon.tsx
├── hooks/
│   └── use-agent-stream.ts       # Agent SSE 流消费 Hook
├── prisma/
│   └── schema.prisma             # 数据模型（14 个模型，cause schema）
├── scripts/                      # 运维脚本
├── tests/                        # Vitest 单元测试
├── doc/                          # 设计文档与本 Wiki
├── docker-compose.yml            # 本地 PostgreSQL + Redis
├── next.config.ts                # Next.js 配置（安全头+外部依赖）
├── prisma.config.ts              # Prisma 7 配置（连接串来源）
└── package.json
```

---

## 3. 分层架构

项目采用清晰的分层架构，自上而下：

```
┌─────────────────────────────────────────────────────────┐
│  表现层 (app/(dashboard)/)                               │
│  页面组件 / 客户端交互 / SSE 消费 / 画布渲染            │
├─────────────────────────────────────────────────────────┤
│  API 层 (app/api/v1/)                                   │
│  REST 路由 / Zod 校验 / SSE 响应 / 身份桩               │
├─────────────────────────────────────────────────────────┤
│  服务端核心层 (lib/server/)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Agent 系统│ │ 算子层   │ │ 语义层   │ │ 投递服务 │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐   │
│  │ 连接器层 │ │ 洞察服务 │ │ 模型网关/调度/SSE/IDs │   │
│  └──────────┘ └──────────┘ └──────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  数据层 (lib/db/ + prisma/)                             │
│  Prisma Client 单例 / PostgreSQL / cause schema         │
└─────────────────────────────────────────────────────────┘
```

### 3.1 层间调用规则

- **表现层 → API 层**：通过 `fetch` 调用 `/api/v1/*`，流式接口使用 `ReadableStream` 消费 SSE
- **API 层 → 服务端核心层**：直接 import 服务端模块，所有 AI 调用必须经 `model-gateway.ts`
- **服务端核心层 → 数据层**：统一通过 `lib/db/index.ts` 导出的 `prisma` 单例，禁止绕过
- **跨层禁止**：前端组件不得直接 import `lib/server/*`（Next.js 服务端/客户端边界）

---

## 4. API 层（app/api/v1/）

### 4.1 API 路由清单

| 路由 | 方法 | 功能 | 关键文件 |
|------|------|------|----------|
| `/ask` | POST | 创建问答并运行多 Agent 工作流（SSE 流式） | `ask/route.ts` |
| `/ask` | GET | 问答列表（分页，排除深度研究） | `ask/route.ts:126` |
| `/ask/[id]` | GET | 问答详情 | `ask/[id]/route.ts` |
| `/research` | POST | 发起深度研究任务（SSE 流式，maxDuration=600s） | `research/route.ts` |
| `/research` | GET | 深度研究任务列表（主任务） | `research/route.ts:192` |
| `/research/[id]` | GET | 研究任务详情（含子任务） | `research/[id]/route.ts` |
| `/insights` | POST/GET | 洞察画布 CRUD | `insights/route.ts` |
| `/insights/[id]` | GET/PUT/DELETE | 洞察文档详情/更新/删除 | `insights/[id]/route.ts` |
| `/insights/[id]/bindings` | POST/GET | 画布绑定管理 | `insights/[id]/bindings/route.ts` |
| `/insights/bindings/[id]` | PUT/DELETE | 单个绑定更新/删除 | `insights/bindings/[id]/route.ts` |
| `/insights/[id]/deliver` | POST | 立即投递（邮件/图片） | `insights/[id]/deliver/route.ts` |
| `/insights/[id]/export` | POST | 导出画布 PNG | `insights/[id]/export/route.ts` |
| `/datasources` | POST/GET | 数据源 CRUD | `datasources/route.ts` |
| `/datasources/[id]` | GET/PUT/DELETE | 数据源详情/更新/删除 | `datasources/[id]/route.ts` |
| `/datasources/[id]/[action]` | POST | 连接测试 / 表列表 / 预览 | `datasources/[id]/[action]/route.ts` |
| `/metrics` | GET/POST | 指标管理 | `metrics/route.ts` |
| `/semantic/models` | GET/POST | 语义模型管理 | `semantic/models/route.ts` |
| `/semantic/models/[id]` | GET/PUT/DELETE | 语义模型详情 | `semantic/models/[id]/route.ts` |
| `/semantic/translate` | POST | 自然语言 → SemanticQuery 转译 | `semantic/translate/route.ts` |
| `/operators` | GET | 算子列表（按分类分组） | `operators/route.ts` |
| `/schedules` | POST/GET | 定时任务 CRUD | `schedules/route.ts` |
| `/schedules/[id]` | GET/PUT/DELETE | 定时任务详情 | `schedules/[id]/route.ts` |
| `/schedules/run` | POST | 立即扫描并执行到期任务 | `schedules/run/route.ts` |
| `/dashboard/stats` | GET | 工作台统计数据 | `dashboard/stats/route.ts` |

### 4.2 统一 API 运行时（lib/server/api-runtime.ts）

所有 API 路由遵循统一模板：

```typescript
// 1. 身份验证（当前为开发桩，返回固定用户）
const actor = await requireActor(request);
// 2. Zod 校验请求体
const input = RequestSchema.parse(await readJson(request));
// 3. 业务逻辑
// 4. 成功响应
return ok(data, 201);
// 5. 统一错误处理（catch 中）
return handleApiError(error);
```

**三类错误处理**（`api-runtime.ts:72`）：
- `ApiError` → 结构化业务错误（status/code/message/retryable/details）
- `ZodError` → 400 INVALID_REQUEST + 字段详情
- 未知错误 → 500 INTERNAL_ERROR（隐藏内部细节，console.error 记录）

**安全响应头**（`api-runtime.ts:22`）：所有响应附加 `cache-control: no-store` / `x-content-type-options: nosniff` / `x-frame-options: DENY` / `referrer-policy: no-referrer` / `permissions-policy`。

> **注意**：`requireActor` 当前为开发桩（`api-runtime.ts:48`），返回固定用户 `user_dev_default`，后续迭代接入企业 SSO / next-auth。

---

## 5. Agent 系统（lib/server/agents/）

Agent 系统是项目的核心，包含两套互补的工作流：

### 5.1 Supervisor 多 Agent 工作流（问答级）

**文件**：`supervisor.ts`

基于 LangGraph `StateGraph` 构建的有向图，拓扑如下：

```
START → supervisor（意图路由）
  ├─ direct        → direct_answer（流式）──────────────────→ END
  ├─ data_analysis → data_analyst（ReAct Worker）→ synthesizer → END
  └─ research      → researcher（ReAct Worker）→ critic
                       ├─ 通过     → synthesizer ─────────→ END
                       └─ 需修正   → researcher（重试≤1）→ critic → ...
```

**图状态**（`supervisor.ts:29`）：
- `ctx`：运行上下文（引用，贯穿全图）
- `route`：路由决策（direct / data_analysis / research）
- `dataSummary`：数据分析 Worker 总结
- `researchSummary`：研究 Worker 总结
- `researchAttempts`：critic 重试计数（最多 2 轮）
- `critique`：critic 结论（passed/score/issues）
- `finalAnswer`：最终答案（增量累积）

**各节点职责**：

| 节点 | 职责 | 关键实现 |
|------|------|----------|
| `supervisor` | LLM 意图分类，温度=0，输出 JSON `{route, reason}` | `supervisor.ts:57` |
| `direct_answer` | 直接流式回答，温度=0.5 | `supervisor.ts:103` |
| `data_analyst` | 调用 `runDataAnalystWorker`，ReAct 循环 | `supervisor.ts:130` |
| `researcher` | 调用 `runResearchWorker`，支持 critic 反馈重试 | `supervisor.ts:138` |
| `critic` | 硬校验（证据≥2条+引用≥1个）+ LLM 软校验（覆盖度/一致性） | `supervisor.ts:156` |
| `synthesizer` | 汇聚全部产出（数据发现+研究证据+critic+原始SQL），流式生成最终回答 | `supervisor.ts:220` |

**递归限制**：`recursionLimit: 60`（`supervisor.ts:357`）

### 5.2 深度研究工作流（任务级）

**文件**：`deep-research.ts`

面向用户显式发起的深度研究任务，产出正式报告，每个子问题作为子任务可追踪。

**状态机**（对应 `ResearchState` 枚举）：
```
queued → planning → collecting → analyzing → writing → completed | failed
```

**执行阶段**：

| 阶段 | 职责 | 关键实现 |
|------|------|----------|
| **Planner** | LLM 拆解 3-5 个子问题 + 检索关键词，输出 JSON | `deep-research.ts:101` |
| **Executor** | 逐子问题：SearchOp 多轮检索（≤3轮）→ ExtractOp 深读（standard=2页/deep=3页）→ LLM 证据抽取 | `deep-research.ts:169` |
| **Analyzing** | CompareOp 多源交叉比对（共识/分歧/置信度），证据过少时跳过 | `deep-research.ts:307` |
| **Synthesizer** | 汇总全部证据 + 比对结论 + 来源背景，流式生成结构化报告（maxTokens=8192） | `deep-research.ts:432` |

**引用管理**：`CitationRegistry` 类（`deep-research.ts:76`）全局去重分配编号，URL 去重。

**与 Supervisor 的关系**：Supervisor 中的 `research` 路径是问答级的轻量研究（ReAct Worker + Critic），而 `deep-research.ts` 是任务级的正式研究（Planner 拆解 + 逐子问题 + 多源比对 + 正式报告）。两者互补。

### 5.3 Worker Agent（workers.ts）

基于 LangGraph `createReactAgent` 的 ReAct 循环 Agent。

**DataAnalystWorker**（`workers.ts:51`）：
- 工具集：`run_operator`（优先）/ `sql_query` / `inspect_schema` / `show_table` / `generate_chart`
- 温度=0，`recursionLimit: 50`
- 算子优先原则：标准分析动作必须先调算子，算子无法表达时退回 SQL

**ResearchWorker**（`workers.ts:106`）：
- 工具集：`web_search` / `fetch_page` / `record_finding` + 动态加载 `query_api_source` / `query_mcp_source`（仅当已注册 active 的 api/mcp 数据源时）
- 温度=0.2
- 兜底机制：模型未主动 `record_finding` 但已有搜索证据时，自动将搜索摘要转正为发现（`workers.ts:157`）

### 5.4 Agent 工具集（tools.ts）

LangChain `tool` 封装，每个工具执行时通过 `ctx.sink` 实时推送 `tool_call` / `tool_result` 事件。

| 工具 | 类别 | 功能 |
|------|------|------|
| `run_operator` | 数据分析 | 执行预置数据分析算子（aggregate/timeseries/anomaly/filter/transform/join） |
| `sql_query` | 数据分析 | 只读 SQL 查询（白名单校验，禁止写操作） |
| `inspect_schema` | 数据分析 | 内省数据库表结构 |
| `show_table` | 数据分析 | 预览表数据（LIMIT 100） |
| `generate_chart` | 数据分析 | 生成 ChartSpec（bar/line/area/pie/radar/composed） |
| `web_search` | 研究 | 互联网搜索（Bing/DuckDuckGo） |
| `fetch_page` | 研究 | 抓取网页正文（cheerio 解析） |
| `record_finding` | 研究 | 记录研究发现到上下文证据池 |
| `query_api_source` | 外部数据源 | 调用已注册的 REST/GraphQL API 数据源 |
| `query_mcp_source` | 外部数据源 | 调用已注册的 MCP 代理 |

### 5.5 Agent 事件协议（events.ts）

SSE 流式输出的统一契约，事件类型：

| 事件 | 载荷 | 说明 |
|------|------|------|
| `meta` | questionId, model | 运行元信息 |
| `phase` | phase, label | 阶段切换（routing/data_analysis/research/analyzing/critique/synthesis） |
| `plan` | objective, subQuestions | 研究计划（深度研究） |
| `step` | stepId, agent, label, status, detail | 步骤状态（running/done/error） |
| `tool_call` | stepId, tool, input | 工具调用开始 |
| `tool_result` | stepId, tool, summary, elapsedMs | 工具调用结果 |
| `table` | table（TablePayload） | 表格数据 |
| `chart` | chart（ChartSpec） | 图表规格 |
| `chunk` | content | 流式文本增量 |
| `citations` | citations[] | 引用来源列表 |
| `done` | questionId, elapsedMs | 完成 |
| `error` | message | 错误 |

**运行上下文**（`AgentRunContext`，`events.ts:59`）贯穿整个工作流，包含：
- `dataFindings`：SQL 列表 / 表格列表 / 图表列表
- `researchFindings`：发现笔记 / 引用 / 检索词 / 搜索摘要 / 已抓取 URL
- `route` / `critique` / `stepCounter` / `startedAt`

### 5.6 问答 API 调用链（ask/route.ts）

```
POST /api/v1/ask
  → requireActor（身份桩）
  → Zod 校验（AskRequestSchema）
  → ensureUserExists（自动创建桩用户）
  → buildConversationContext（多轮追问：优先压缩摘要，兜底回溯4轮）
  → prisma.question.create（status=analyzing）
  → sseResponse
      → runAgentWorkflow（Supervisor 多 Agent）
          → supervisor 路由
          → direct/data_analysis/research 路径
          → critic（research 路径）
          → synthesizer（汇聚流式输出）
      → compressConversationContext（增量压缩会话上下文）
      → prisma.question.update（status=completed，answer 含 charts/tables/sql/citations/critique/contextSummary）
      → persistAgentTasks（写入 research_tasks 轨迹）
      → send({type: "done"})
```

**多轮上下文压缩**（`ask/route.ts:238`）：每轮完成后用 LLM 将「已有摘要 + 本轮问答」压缩为新摘要（≤800 token），随 answer 落库。下一轮追问优先使用压缩摘要，避免长原文撑爆各节点窗口。LLM 失败时降级为机械拼接。

---

## 6. 连接器层（lib/server/connectors/）

### 6.1 数据源注册与解析（datasources.ts）

**内置数据源**（随环境自动可用）：
- `data_source_demo_pg`：演示 PostgreSQL 库（`env.DATABASE_URL`，含 demo/cause/public schema）
- `data_source_web`：互联网检索源（Bing/DuckDuckGo，无需连接串）

**自定义数据源**（存于 `data_sources` 表）：
- `bi`：PostgreSQL 连接串
- `api`：外部开放平台 API（REST / GraphQL）
- `mcp`：内部 MCP 代理（streamable HTTP）
- `web` / `browser`：枚举预留

**核心函数**：
- `listDataSources()`：列出全部数据源（内置 + 自定义），返回带 `status`（active/misconfigured）
- `resolveDataSource(id)`：解析单个数据源
- `displayEndpoint(source)`：脱敏展示 endpoint（仅保留 host/db）
- `maskUrl(url)`：连接串脱敏

### 6.2 PostgreSQL 连接器（postgres.ts）

- `executeReadOnlyQuery(sql, params)`：执行只读 SQL（白名单校验，禁止 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE）
- `introspectSchema(url?)`：内省数据库表结构（表名/列名/类型/注释）
- 使用 `pg` 驱动直连，不经过 Prisma（用于 Agent 动态查询第三方数据源）

### 6.3 API 连接器（api.ts）

- `executeRestRequest(config, method, path, params)`：执行 REST API 请求
- `executeGraphQLQuery(config, query, variables)`：执行 GraphQL 查询
- 支持认证头、超时、响应解析

### 6.4 MCP 连接器（mcp.ts）

- `runMcpReactAgent(config, prompt)`：通过 MCP 代理（streamable HTTP）执行工具调用
- 使用 `@langchain/mcp-adapters` 适配

### 6.5 Web 连接器（web.ts）

- `webSearch(query, maxResults)`：互联网搜索（Bing 优先，DuckDuckGo 兜底）
- `fetchPage(url)`：抓取网页正文（cheerio 解析 HTML，提取标题/正文/元数据）
- `FIRECRAWL_API_KEY` 配置时可使用 Firecrawl 增强抓取

---

## 7. 算子层（lib/server/operators/）

### 7.1 算子注册表（registry.ts）

数据分析算子（SQL 引擎）+ 研究算子（LLM 引擎）统一注册，每个算子 = 元数据（Meta）+ 输入 Schema（Zod）+ 执行函数。

**已注册算子**：

| 算子 ID | 类别 | 引擎 | 功能 |
|---------|------|------|------|
| `aggregate` | 数据 | SQL | 聚合查询（指标×维度） |
| `timeseries` | 数据 | SQL | 时间序列分析（按日/周/月） |
| `anomaly` | 数据 | SQL | 异常检测（偏离均值/中位数） |
| `filter` | 数据 | SQL | 条件过滤查询 |
| `transform` | 数据 | SQL | 数据转换（计算派生列） |
| `join` | 数据 | SQL | 多表关联查询 |
| `search` | 研究 | LLM | 互联网检索 |
| `extract` | 研究 | LLM | 网页深读与要点抽取 |
| `summarize` | 研究 | LLM | 文本摘要 |
| `compare` | 研究 | LLM | 多源交叉比对（共识/分歧/置信度） |
| `citation` | 研究 | LLM | 引用检索与核验 |
| `write` | 研究 | LLM | 定长段落生成 |

**核心函数**：
- `listOperators()`：列出全部算子元数据
- `getOperator(id)`：获取单个算子元数据
- `runOperator(id, input)`：执行算子（输入经 Zod 校验，失败返回结构化错误）

### 7.2 数据分析算子（data-operators.ts）

- 输入 Schema 由语义层指标目录动态生成（指标/维度白名单）
- 执行时转译为只读 PostgreSQL SQL，经 `postgres.ts` 执行
- 返回统一结构 `OperatorRunResult`：`{ok, operatorId, columns, rows, rowCount, elapsedMs, notes, error}`

### 7.3 研究算子（research-operators.ts）

- 输入 Schema 静态定义（与语义层目录无关）
- 基于 LLM + 连接器执行（search 用 web 连接器，extract 用 web+LLM，compare 用 LLM）
- 深度研究工作流优先使用 `search` / `extract` / `compare` 算子；`write` 算子为定长段落生成器无法流式成稿，`citation` 算子会重复检索，故深度研究的报告生成由 Agent 提示词承担（`deep-research.ts:18-20`）

---

## 8. 语义层（lib/server/semantic/）

### 8.1 语义查询模型（semantic-query.ts）

**SemanticQueryV1 Schema**（`semantic-query.ts:16`）：

```typescript
{
  intent: "query" | "compare" | "trend" | "breakdown" | "anomaly" | "forecast"
  metrics: [{ metricId, alias? }]           // 至少1个
  dimensions: [{ dimensionId, granularity? }] // 默认[]
  filters: [{ field, operator, value }]       // 默认[]
  timeRange: { from?, to?, granularity? }     // 默认{}
  sort: [{ field, direction }]?                // 可选
  limit: number?                                // 可选，最大2000
}
```

### 8.2 内置语义模型

5 个内置语义模型（`semantic-query.ts:90`），对应 demo 数据集：

| 模型 ID | 名称 | 表 | 核心指标 | 核心维度 |
|---------|------|-----|----------|----------|
| `semantic_model_daily_metrics` | 经营日指标 | `demo.daily_metrics` | GMV/订单量/活跃用户/新增用户/转化率/客单价 | 区域/渠道/日期 |
| `semantic_model_orders` | 订单明细 | `demo.orders` | 订单数/订单金额/件数/退款率 | 区域/渠道/类目/状态/下单时间 |
| `semantic_model_products` | 商品维表 | `demo.products` | 商品数/均价/平均成本 | 类目 |
| `semantic_model_channel_daily` | 投放渠道日指标 | `demo.channel_daily_metrics` | 花费/展示/点击/下载/注册/FD用户/FD金额/RD用户/RD金额 | 投放渠道/承接端/市场/日期 |
| `semantic_model_channel_campaigns` | 投放计划 | `demo.channel_campaigns` | 计划数/累计花费/累计下载/累计FD用户/累计RD用户 | 投放渠道/承接端/投放目标/状态/启动日期 |

### 8.3 SemanticQuery → SQL 转译（translateToSql）

**转译规则**（`semantic-query.ts:233`）：
1. **定位主模型**：找第一个能承载全部指标/维度的模型（按指标名匹配，评分=指标×2+维度×1）
2. **SELECT 列**：指标 → 聚合表达式（sum/avg/count/max/min/none）；维度 → GROUP BY 列（时间维度按粒度截断：day/week/month/quarter/year）
3. **WHERE 条件**：过滤操作符映射（eq/neq/gt/gte/lt/lte/in/like/between），参数内联前做类型净化
4. **时间范围**：时间列 BETWEEN
5. **GROUP BY → ORDER BY → LIMIT**（标准 SQL 子句顺序，默认 LIMIT 200）

**安全机制**：
- `quoteIdent()`：SQL 标识符仅允许字母数字下划线（`semantic-query.ts:415`）
- `sqlString()`：字符串字面量单引号逃逸（`semantic-query.ts:405`）
- 转译后的 SQL 仍需经 `postgres.ts` 的只读白名单校验

### 8.4 语义模型存储（model-store.ts）

- 管理 `semantic_models` 表的 CRUD
- 支持内置模型 + 自定义模型合并查询
- 自定义模型的 `dataSourceId` 为空时表示内置演示经营库

---

## 9. 洞察画布层（lib/server/insights/）

### 9.1 数据模型

洞察画布整合了原报告 / 看板 / 日报三模块：

**InsightDoc**（`schema.prisma:321`）：
- `kind`：report / board / digest（`InsightDocKind` 枚举）
- `status`：draft / published / archived
- `snapshot`：tldraw `loadSnapshot` 可还原的 store 快照（JSON）
- 关联：creator / workspace / bindings / schedules / deliveries

**CanvasBinding**（`schema.prisma:344`）：
- 画布形状与数据源的实时绑定
- `sourceType`：question / research / metric（`BindingSourceType` 枚举）
- `sourceId`：question_xxx / task_xxx
- `payload`：ChartSpec / 指标值 / markdown / 引用（最新内容缓存）
- `sourceStatus`：源任务状态（running/completed/failed...）

### 9.2 核心服务

| 文件 | 功能 |
|------|------|
| `bindings.ts` | 画布绑定 CRUD、绑定 payload 更新、源状态同步 |
| `extract.ts` | 从画布快照提取文本/图表/数据内容 |
| `snapshot.ts` | tldraw store 快照处理、文本提取（`extractTextFromSnapshot`） |

### 9.3 画布编辑器（前端）

- `app/(dashboard)/insights/[id]/canvas-editor.tsx`：基于 tldraw 的画布编辑器
- `components/canvas/`：AddToCanvasDialog（添加到画布对话框）、ImportPanel（导入面板）、live-shape（实时绑定形状渲染）
- `components/charts/ChartRenderer.tsx`：Recharts 图表渲染器（消费 Agent 生成的 ChartSpec）

---

## 10. 投递服务（lib/server/delivery/）

### 10.1 统一入口（index.ts）

`deliver(channelName, input)` 执行一次投递并落流水：
1. 先创建 `queued` 状态的 `DeliveryRecord`
2. 调用渠道的 `deliver(input)` 执行
3. 回填 `DeliveryRecord` 状态（sent/failed）与详情
4. 返回 `{id, status, detail}`

### 10.2 投递渠道

| 渠道 | 文件 | 功能 |
|------|------|------|
| `email` | `email-channel.ts` | SMTP 邮件发送（未配置 SMTP 时 mock 模式，记录收件人但不实际发送） |
| `image` | `image-channel.ts` | 画布 PNG 导出（客户端渲染后上传，服务端记录最近一次导出路径） |

**渠道接口**（`channel.ts`）：`DeliveryChannel { name, deliver(input): Promise<DeliveryResult> }`

### 10.3 定时调度（scheduler.ts）

> **关键设计决策**：不在 Next 进程内常驻定时器，由 `POST /api/v1/schedules/run` 驱动（UI「立即执行」按钮 + 外部 cron 定时 curl）。

**执行流程**（`runDueJobs`，`scheduler.ts:48`）：
1. 查询 `enabled=true AND nextRunAt <= now` 的任务
2. 对每个任务：
   - 从画布快照提取文本（`extractTextFromSnapshot`）
   - 获取最近一次导出 PNG（`latestExportPng`）
   - `email` 动作：正文取画布文本，附件取最近一次导出 PNG
   - `export` 动作：记录最近一次导出图片（画布 PNG 由客户端渲染，服务端无法重绘）
3. 回填 `lastRunAt` 并推进 `nextRunAt`（`cron-parser` 计算）

**ScheduleJob 模型**（`schema.prisma:364`）：
- `action`：email / export（`ScheduleAction` 枚举）
- `cronExpr`：标准 5 段 cron 表达式
- `recipients`：收件人列表（JSON）
- `enabled` / `lastRunAt` / `nextRunAt`
- 索引：`[enabled, nextRunAt]`（加速到期查询）

---

## 11. 数据层（lib/db/ + prisma/）

### 11.1 Prisma 配置

- **Prisma 7 特性**：`schema.prisma` 中 `datasource` 不再内联 url，连接串由 `prisma.config.ts` 提供
- **运行时 adapter**：`@prisma/adapter-pg` 的 `PrismaPg`，显式传入 `schema` 参数（从 `DATABASE_URL` 的 `?schema=` 解析，缺省回退 public）
- **生成输出**：`lib/db/generated/client/`（ESM 格式，`.ts` 扩展名）
- **单例模式**：`lib/db/index.ts` 导出 `prisma`，开发环境热重载时复用全局实例避免连接池泄漏
- **Next.js 配置**：`next.config.ts:18` 将 `@prisma/client` 设为 `serverExternalPackages`（Prisma 7 客户端运行时含 query compiler WASM，不参与打包）

### 11.2 数据模型总览（14 个模型，全部 cause schema）

#### 用户与权限（3 个）

| 模型 | 表名 | 说明 |
|------|------|------|
| `User` | `users` | 用户（id/email/name/departmentId/role） |
| `Workspace` | `workspaces` | 工作区（id/name/ownerId/dataSourceIds） |
| `Permission` | `permissions` | RBAC+ABAC 混合权限（subjectType/subjectId/resourceType/resourceId/action） |

#### 语义层（3 个）

| 模型 | 表名 | 说明 |
|------|------|------|
| `DataSource` | `data_sources` | 数据源（id/name/type/config/connectorId） |
| `Metric` | `metrics` | 指标（id/name/description/formula/unit/ownerId/status/version/dataSourceId） |
| `SemanticModel` | `semantic_models` | 语义模型（id/name/dataSourceId/tableRef/fields） |

#### 任务与研究（2 个）

| 模型 | 表名 | 说明 |
|------|------|------|
| `Question` | `questions` | 问答载体（id/userId/workspaceId/content/context/status/answer） |
| `ResearchTask` | `research_tasks` | 研究任务（id/questionId/parentTaskId/agentType/status/input/output/citations/startedAt/completedAt） |

#### 洞察画布（4 个）

| 模型 | 表名 | 说明 |
|------|------|------|
| `InsightDoc` | `insight_docs` | 洞察画布文档（id/title/kind/description/snapshot/status/createdBy/workspaceId） |
| `CanvasBinding` | `canvas_bindings` | 画布实时绑定（id/docId/shapeId/sourceType/sourceId/query/payload/sourceStatus） |
| `ScheduleJob` | `schedule_jobs` | 定时任务（id/docId/action/cronExpr/recipients/enabled/lastRunAt/nextRunAt） |
| `DeliveryRecord` | `delivery_records` | 投递记录（id/docId/channel/status/detail/createdAt） |

#### 审计（1 个）

| 模型 | 表名 | 说明 |
|------|------|------|
| `AuditLog` | `audit_logs` | 审计日志（id/userId/action/resource/resourceId/detail/ip/createdAt） |

### 11.3 关键枚举

| 枚举 | 值 |
|------|-----|
| `UserRole` | admin / analyst / operator / viewer |
| `DataSourceType` | bi / api / mcp / web / browser |
| `ResearchState` | queued / planning / collecting / analyzing / verifying / writing / reviewing / completed / failed |
| `AgentType` | supervisor / data_analyst / researcher / critic |
| `InsightDocKind` | report / board / digest |
| `BindingSourceType` | question / research / metric |
| `ScheduleAction` | email / export |
| `DeliveryChannelType` | email / image |
| `DeliveryStatus` | queued / sent / failed |
| `AuditAction` | create / read / update / delete / query / export / login / logout |

### 11.4 ID 规范

所有业务 ID 使用 `prefix_uuid` 格式（`lib/server/ids.ts` 的 `newId(prefix)`）：

| 前缀 | 实体 |
|------|------|
| `user_` | User |
| `workspace_` | Workspace |
| `data_source_` | DataSource |
| `metric_` | Metric |
| `semantic_model_` | SemanticModel |
| `question_` | Question |
| `task_` | ResearchTask |
| `insight_` | InsightDoc |
| `binding_` | CanvasBinding |
| `schedule_` | ScheduleJob |
| `delivery_` | DeliveryRecord |
| `audit_` | AuditLog |

---

## 12. 统一模型网关（lib/server/model-gateway.ts）

### 12.1 设计目标

所有 AI 调用的唯一入口（`design.md 12.1`），提供主备网关自动降级。

### 12.2 主备降级机制

- **主网关**：`MODEL_GATEWAY_BASE_URL` / `MODEL_GATEWAY_API_KEY` / `MODEL_GATEWAY_DEFAULT_MODEL`
- **备用网关**：`MODEL_GATEWAY_FALLBACK_URL` / `MODEL_GATEWAY_FALLBACK_KEY` / `MODEL_GATEWAY_FALLBACK_MODEL`（可选，三者齐全才启用）
- **熔断条件**：主网关返回 401/403/5xx 或超时/连接错误（`isGatewayUnavailable`，`model-gateway.ts:88`）
- **冷却期**：5 分钟（`PRIMARY_COOLDOWN_MS`，`model-gateway.ts:44`），冷却期内直接走备用
- **恢复检测**：冷却期外请求优先走主网关，成功则标记恢复

### 12.3 对外接口

| 接口 | 功能 |
|------|------|
| `chatCompletion(messages, options?)` | 非流式补全（自动降级 + reasoning 模型空 content 自动加倍重试） |
| `chatCompletionStream(messages, options?)` | 流式补全（AsyncGenerator，自动降级） |
| `getChatModel(options?)` | LangChain `ChatOpenAI` 工厂（供 LangGraph Agent 使用） |
| `getDefaultModel()` | 当前活跃模型名 |
| `activeGateway()` | 当前活跃网关配置 |
| `gatewayHealth()` | 网关健康检查（返回 active/model/ok/latencyMs/error） |

### 12.4 reasoning 模型适配

`chatCompletion` 对 reasoning 模型（如 mimo）做了特殊处理（`model-gateway.ts:129`）：
- reasoning 模型会先输出思考过程，`max_tokens` 过小时 `content` 为空
- 默认给足预算（≥2048），若 content 为空则加倍 `max_tokens` 重试一次（最多 8192）

---

## 13. 前端架构

### 13.1 页面结构（app/(dashboard)/）

工作台采用「侧边栏 + 顶栏 + 主内容区」三栏布局（`layout.tsx`）：

- **侧边栏**（`sidebar.tsx`）：导航菜单（工作台/问答/深度研究/洞察画布/数据源/语义层/算子）
- **顶栏**（`topbar.tsx`）：搜索/通知/用户信息
- **主内容区**：各页面路由

**页面模式**：每个页面遵循 `page.tsx`（服务端组件，导出 metadata + 渲染 client）+ `client.tsx`（客户端组件，`"use client"` + 交互逻辑）+ `loading.tsx`（加载骨架）的标准结构。

### 13.2 前端状态与数据

- **SWR**：服务端数据请求缓存与重新验证
- **Zustand**：客户端交互状态（如画布编辑器状态、Agent 流状态）
- **use-agent-stream**（`hooks/use-agent-stream.ts`）：封装 SSE 流消费，维护 Agent 事件状态机（步骤列表/工具调用/表格/图表/流式文本/引用）

### 13.3 前端组件

| 组件 | 功能 |
|------|------|
| `agent/AgentTimeline` | Agent 执行时间线展示（phase/step/tool_call/tool_result） |
| `agent/MarkdownView` | Markdown 渲染（react-markdown + remark-gfm） |
| `canvas/AddToCanvasDialog` | 将问答/研究结果添加到画布的对话框 |
| `canvas/ImportPanel` | 画布导入面板 |
| `canvas/live-shape` | 画布实时绑定形状（数据源内容动态更新） |
| `charts/ChartRenderer` | Recharts 图表渲染器（消费 ChartSpec） |
| `data/DataTable` | 通用数据表格 |
| `logo-icon` | Logo 组件 |

### 13.4 设计系统

- CSS 变量定义在 `app/globals.css`（颜色/间距/字体/状态灯/焦点环/滚动条）
- Tailwind CSS v4 实用类 + `style` 内联 CSS 变量
- `cn()`（`lib/utils.ts`）合并类名（clsx + tailwind-merge）
- Radix UI 原语（dialog/dropdown-menu/label/select/separator/tabs/toast/tooltip）

---

## 14. 环境变量与配置

### 14.1 环境变量校验（lib/env.ts）

所有环境变量经 Zod 校验，校验失败立即抛错（fail fast）。

| 变量 | 必填 | 说明 |
|------|------|------|
| `NODE_ENV` | 否 | development/test/production，默认 development |
| `APP_ENV` | 否 | development/staging/production，默认 development |
| `APP_URL` | 否 | 默认 http://localhost:3000 |
| `AUTH_SECRET` | 是 | 会话签名密钥，至少 32 字符 |
| `MODEL_GATEWAY_BASE_URL` | 是 | 主模型网关 URL |
| `MODEL_GATEWAY_API_KEY` | 是 | 主模型网关密钥 |
| `MODEL_GATEWAY_DEFAULT_MODEL` | 是 | 默认模型名 |
| `MODEL_GATEWAY_TIMEOUT_MS` | 否 | 默认 120000 |
| `MODEL_GATEWAY_FALLBACK_*` | 否 | 备用网关（URL/KEY/MODEL 三者齐全才启用） |
| `DATABASE_URL` | 是 | PostgreSQL 连接串（含 `?schema=cause`） |
| `REDIS_URL` | 否 | 默认 redis://localhost:6379 |
| `MQ_URL` | 否 | 消息队列（预留） |
| `MCP_GATEWAY_*` | 否 | MCP Gateway（OAuth2.1，预留） |
| `FIRECRAWL_API_KEY` | 否 | Firecrawl 网页抓取增强 |
| `FIRECRAWL_BASE_URL` | 否 | 默认 https://api.firecrawl.dev |
| `OBJECT_STORAGE_*` | 否 | 对象存储（endpoint/access_key/secret_key/bucket） |

### 14.2 Next.js 配置（next.config.ts）

- `reactStrictMode: true`
- `poweredByHeader: false`（隐藏 X-Powered-By）
- `serverExternalPackages: ["@prisma/client"]`（Prisma 7 客户端不参与打包）
- 安全响应头：`X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### 14.3 Docker 本地环境（docker-compose.yml）

- PostgreSQL（主存储，schema=cause）
- Redis（缓存/会话，预留）

---

## 15. 脚本与测试

### 15.1 运维脚本（scripts/）

| 脚本 | 功能 |
|------|------|
| `db-smoke.ts` | 数据库冒烟测试（连接/Schema/基础查询） |
| `agent-smoke.ts` | Agent 冒烟测试（模型网关/简单问答） |
| `seed-demo-data.ts` | 演示数据种子（经营日指标/订单/商品/投放数据） |
| `seed-acquisition-data.ts` | 买量数据种子（投放渠道/计划） |
| `migrate-insights.ts` | 洞察数据迁移脚本 |
| `repair-snapshots.ts` | 画布快照修复脚本 |
| `i18n-check.mjs` | 国际化键值检查 |

### 15.2 测试（tests/）

| 测试文件 | 覆盖范围 |
|----------|----------|
| `smoke.test.ts` | 基础冒烟测试 |
| `datasources.test.ts` | 数据源注册与解析 |
| `operators.test.ts` | 算子注册与执行 |
| `deep-research-operators.test.ts` | 深度研究算子 |
| `insights.test.ts` | 洞察画布服务 |
| `semantic-models.test.ts` | 语义模型与 SQL 转译 |
| `research-source.test.ts` | 研究来源上下文 |
| `context-summary.test.ts` | 会话上下文压缩 |

**测试命令**：`npm run test`（Vitest run）/ `npm run test:watch`（watch 模式）

---

## 16. 关键设计决策

### 16.1 已实施的决策

1. **统一模型边界**：所有 AI 调用经 `model-gateway.ts`，主备自动降级，禁止业务代码直接调用 OpenAI SDK
2. **Adapter 可替换**：数据源通过 Connector 模式支持多后端（PG/API/MCP/Web），新增数据源只需实现连接器
3. **Schema 优先**：所有外部输入（请求体/环境变量/算子参数）使用 Zod 校验，fail fast
4. **安全默认**：响应附加安全头，SQL 只读白名单，标识符/字符串净化
5. **ESM Only**：`"type": "module"`，全项目 ESM
6. **Prisma 7 新范式**：schema.prisma 无 url，prisma.config.ts 提供连接串，运行时 PrismaPg 显式传 schema
7. **SSE 流式**：问答/研究全程事件推送，前端可完整展示 Agent 的每一步动作与产出
8. **算子优先**：标准分析动作必须先调算子（run_operator），算子无法表达时退回 SQL
9. **洞察画布统一**：整合原报告/看板/日报三模块为 InsightDoc（kind 区分），基于 tldraw 无限画布
10. **定时任务外部驱动**：不在 Next 进程内常驻定时器，由 `POST /api/v1/schedules/run` + 外部 cron 驱动，避免 Serverless 环境限制
11. **多轮上下文压缩**：每轮问答完成后用 LLM 增量压缩会话上下文，避免长原文撑爆各节点窗口
12. **画布 PNG 客户端渲染**：服务端无法重绘 tldraw 画布，定时导出依赖客户端最近一次手动导出的 PNG

### 16.2 预留/待实施

- 企业 SSO / OAuth2.1 认证（当前 `requireActor` 为开发桩）
- 看板拖拽布局（@dnd-kit 已安装但未深度集成）
- 日报定时生成与推送（调度框架已就绪，日报生成逻辑待完善）
- 审计日志查看面板（数据模型已就绪，UI 待开发）
- MCP Gateway / Web 抓取深度集成（连接器已就绪，OAuth2.1 待接入）
- 国际化（en / zh-CN，i18n-check 脚本已就绪）
- E2E 测试（当前仅有单元测试）
- Redis 缓存/会话（环境变量已预留，未深度使用）
- 消息队列（MQ_URL 已预留，研究任务当前同步执行）

---

## 17. 开发命令速查

```bash
# 开发
npm run dev              # 启动开发服务器
npm run local:up         # docker compose up -d && npm run dev
npm run local:down       # docker compose down

# 质量
npm run typecheck        # TypeScript 类型检查
npm run lint             # ESLint 检查
npm run test             # Vitest 测试
npm run test:watch       # Vitest watch

# 数据库
npm run db:generate      # 重新生成 Prisma 客户端（postinstall 自动执行）
npm run db:migrate       # 创建并应用迁移（开发）
npm run db:deploy        # 部署迁移（生产）
npm run db:push          # 推送 Schema 到数据库（原型阶段）
npm run db:studio        # Prisma Studio

# 脚本
npx tsx scripts/db-smoke.ts           # 数据库冒烟测试
npx tsx scripts/agent-smoke.ts        # Agent 冒烟测试
npx tsx scripts/seed-demo-data.ts     # 演示数据种子
npm run i18n:check                     # 国际化检查
```

---

## 18. 编码规范摘要

### 18.1 命名

- 组件：PascalCase，文件名 kebab-case
- 函数/变量：camelCase
- 常量：UPPER_SNAKE_CASE
- Zod Schema：PascalCase + `Schema` 后缀
- ID 前缀：`prefix_uuid`（使用 `newId("question")`）

### 18.2 API 路由模板

```typescript
import { z } from "zod";
import { handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";

const RequestSchema = z.object({ /* ... */ });

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const input = RequestSchema.parse(await readJson<unknown>(request));
    // 业务逻辑
    return ok(data, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
```

### 18.3 页面结构

- `page.tsx`：服务端组件（导出 metadata + 渲染 client）
- `client.tsx`：客户端组件（`"use client"` + 交互逻辑）
- `loading.tsx`：加载骨架

### 18.4 注释

所有代码注释必须使用中文。

---

## 附录：文件速查表

| 关注点 | 关键文件 |
|--------|----------|
| 项目元信息 | `package.json`, `CLAUDE.md`, `AGENTS.md` |
| 设计文档 | `doc/design.md`, `doc/detail.md`, `doc/usercase.md` |
| 数据模型 | `prisma/schema.prisma` |
| API 运行时 | `lib/server/api-runtime.ts` |
| 模型网关 | `lib/server/model-gateway.ts` |
| Agent 编排 | `lib/server/agents/supervisor.ts` |
| 深度研究 | `lib/server/agents/deep-research.ts` |
| Agent Worker | `lib/server/agents/workers.ts` |
| Agent 工具 | `lib/server/agents/tools.ts` |
| Agent 事件 | `lib/server/agents/events.ts` |
| Agent 提示词 | `lib/server/agents/prompts.ts` |
| 数据源连接器 | `lib/server/connectors/datasources.ts` |
| PG 连接器 | `lib/server/connectors/postgres.ts` |
| 算子注册表 | `lib/server/operators/registry.ts` |
| 数据算子 | `lib/server/operators/data-operators.ts` |
| 研究算子 | `lib/server/operators/research-operators.ts` |
| 语义查询 | `lib/server/semantic/semantic-query.ts` |
| 洞察绑定 | `lib/server/insights/bindings.ts` |
| 投递服务 | `lib/server/delivery/index.ts` |
| 定时调度 | `lib/server/scheduler.ts` |
| SSE 工具 | `lib/server/sse.ts` |
| Prisma 客户端 | `lib/db/index.ts` |
| 环境变量 | `lib/env.ts` |
| 问答 API | `app/api/v1/ask/route.ts` |
| 研究 API | `app/api/v1/research/route.ts` |
| 工作台布局 | `app/(dashboard)/layout.tsx` |
| 侧边栏 | `app/(dashboard)/sidebar.tsx` |
| 画布编辑器 | `app/(dashboard)/insights/[id]/canvas-editor.tsx` |
| Agent 流 Hook | `hooks/use-agent-stream.ts` |
