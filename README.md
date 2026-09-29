# 归因模块（pt-ai-acquisition-cause）

面向企业内部的**数据驱动决策工具**，聚焦流量投放效果归因场景：提供一站式的数据接入、语义统一、自然语言问答、自动化洞察画布与深度研究能力。系统不是面向公众的 Demo，按企业级安全、合规、可审计、可运维、可扩展要求设计。

> 权威设计规格见 [doc/design.md](doc/design.md)，代码库架构详解见 [doc/codewiki.md](doc/codewiki.md)。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 自然语言问答 | 中文提问，自动路由到「直接回答 / 数据分析 / 深度研究」三条路径，SSE 流式展示 Agent 每一步动作 |
| 深度研究 | Planner 拆解子问题 → SearchOp 检索 / ExtractOp 深读 → CompareOp 多源交叉比对（analyzing 阶段）→ 流式生成带引用溯源的研究报告 |
| 洞察画布 | 基于 tldraw 无限画布，整合原报告 / 看板 / 日报三模块为 InsightDoc，支持实时数据绑定与 PNG 导出 |
| 数据源接入 | 内置演示 PG 库 + 互联网检索；自定义支持 BI（PostgreSQL）/ API（REST/GraphQL）/ MCP 服务 |
| 统一语义层 | 指标字典 + 语义模型 CRUD，自然语言转译为 SemanticQuery 再转 SQL，口径统一、可校验 |
| 算子层 | 数据分析算子（SQL 引擎）+ 研究算子（LLM 引擎）统一注册，工作流「算子优先」调度 |
| 定时投递 | 对洞察文档执行定时邮件 / 图片导出，由 `POST /api/v1/schedules/run` + 外部 cron 驱动 |

## 技术栈

| 维度 | 选型 |
|------|------|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript 5（严格模式、ESM Only） |
| 样式/UI | Tailwind CSS 4 + Radix UI + lucide-react |
| 状态/数据 | Zustand（客户端状态）+ SWR（服务端数据）|
| AI 编排 | LangGraph 1.x（Supervisor 多 Agent 状态图）+ LangChain |
| 模型接入 | OpenAI SDK（兼容协议），统一模型网关，主备自动降级 |
| 数据层 | Prisma 7 + @prisma/adapter-pg + PostgreSQL（schema：`cause`）|
| 可视化 | Recharts（图表）+ tldraw 5（洞察画布）|
| 校验 | Zod 4（所有外部输入：请求体 / 环境变量 / 算子参数）|
| 测试 | Vitest（80 个用例，8 个测试文件）|
| 运行时 | Node.js 24.7.0（nvm 管理）|

## 架构分层

```
┌─────────────────────────────────────────────────────────┐
│ 表现层  app/(dashboard)/  问答 / 研究 / 画布 / 数据源页面 │
├─────────────────────────────────────────────────────────┤
│ API 层  app/api/v1/  REST + SSE / Zod 校验 / 统一运行时  │
├─────────────────────────────────────────────────────────┤
│ 服务层  lib/server/                                      │
│   agents/     Supervisor 多 Agent + 深度研究工作流        │
│   operators/  数据分析算子 + 研究算子（注册表调度）        │
│   semantic/   SemanticQuery 建模与 SQL 转译               │
│   connectors/ PG / API / MCP / Web 数据源连接器           │
│   insights/   洞察画布服务（快照 / 绑定 / 抽取）          │
│   delivery/   邮件 / 图片投递 + 定时调度                  │
│   auth/       OIDC BFF（oidc / access-client / session）  │
│   model-gateway.ts  统一模型网关（主备降级）              │
├─────────────────────────────────────────────────────────┤
│ 数据层  prisma/schema.prisma（16 个模型，cause schema）   │
│         PostgreSQL + pgvector / Redis（预留）             │
└─────────────────────────────────────────────────────────┘
```

关键设计原则：

1. **统一模型边界**——所有 AI 调用经 `lib/server/model-gateway.ts`，禁止业务代码直连模型 SDK
2. **算子优先**——标准分析动作先调算子（`runOperator`），算子无法表达时退回 SQL
3. **Schema 优先**——所有外部输入 Zod 校验，fail fast
4. **安全默认**——响应附加安全头，SQL 只读白名单，标识符净化
5. **身份不落前端**——OIDC BFF 模式：ID Token 只留服务端，浏览器仅持 httpOnly 不透明会话
   cookie；授权由 Access 实时判定（登录期 Entry Gate + 请求期 principal 复核，fail-closed）
6. **SSE 流式**——问答 / 研究全程事件推送，前端完整还原 Agent 执行过程
7. **中文注释**——所有代码注释使用中文

## 目录结构

```
pt-ai-acquisition-cause/
├── app/
│   ├── (dashboard)/          # 工作台路由组（侧边栏 + 顶栏布局）
│   │   ├── ask/              # 任务问答（流式 AI 回答）
│   │   ├── research/         # 深度研究
│   │   ├── insights/         # 洞察画布（列表 / 详情 / 画布编辑器）
│   │   ├── datasources/      # 数据源管理
│   │   ├── semantic/         # 语义层管理
│   │   ├── operators/        # 算子管理
│   │   └── session-watch.tsx # 会话活性监测（失效即重新登录）
│   ├── api/v1/               # REST API（ask / research / insights / datasources /
│   │                         #   metrics / semantic / operators / schedules / dashboard）
│   ├── api/auth/             # OIDC BFF 端点（login / callback / logout / session）
│   └── login/                # 登录页（授权状态机：已登录 / 自动发起 / 已登出 / 授权失败）
├── lib/
│   ├── server/               # 服务端核心（agents / connectors / operators /
│   │                         #   semantic / insights / delivery / auth + 模型网关 / SSE / 调度器）
│   ├── db/                   # Prisma 客户端单例与生成代码
│   └── env.ts                # 环境变量 Zod 校验
├── components/               # AgentTimeline / MarkdownView / ChartRenderer /
│                             #   DataTable / 画布组件
├── hooks/use-agent-stream.ts # Agent SSE 流消费 Hook
├── prisma/schema.prisma      # 数据模型（16 个模型，含 AuthSession / OidcTransaction）
├── scripts/                  # 冒烟测试 / 数据种子 / 迁移修复等运维脚本
├── tests/                    # Vitest 单元测试
└── doc/                      # 设计文档（design.md / codewiki.md / 开发进度等）
```

## 快速开始

### 前置条件

- Node.js 24.7.0（nvm 管理）
- Docker（本地跑 PostgreSQL + Redis）
- 一个 OpenAI 兼容的模型 API（BASE_URL / API_KEY / 模型名）
- 鉴权依赖 PT AI Access 平台（identity :8094 + access-app :4300），二选一：
  - **真实环境**：同级目录 `pt-ai-platform-access`（Keycloak + access-app + PostgreSQL），
    按其 `no-docker-install.md` 第一~九步启动；其中第七/八步（注册 `pt-ai-cause` 客户端、
    添加 `cause` 应用目录与 entitlement）是 cause 能登录的前提
  - **轻量模拟器**：同级目录 `pt-access`（`node server.mjs`，零依赖单文件），
    用于快速验证链路，改 `users.json` 即可热模拟停用/撤权
  - 两者的 `.env` 取值一致（client id/secret、内部密钥、entryId 均为同一套本地默认值），
    切换环境无需改 cause 配置；详见 doc/鉴权接入PT-AI-Access设计.md

### 步骤

```bash
# 1. 安装依赖（postinstall 自动执行 prisma generate）
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：至少填写 MODEL_GATEWAY_BASE_URL / MODEL_GATEWAY_API_KEY /
# MODEL_GATEWAY_DEFAULT_MODEL / DATABASE_URL；
# OIDC_* / ACCESS_* 默认值同时适配本地 pt-access 模拟器与 pt-ai-platform-access 真实环境

# 3. 启动 Access（另开终端，保持运行）——二选一
bash ../pt-ai-platform-access/start-access.sh   # 真实环境（需先起 Keycloak :8094）
node ../pt-access/server.mjs                    # 或轻量模拟器（自带 identity :8094 + access :4300）

# 4. 启动本地依赖并运行开发服务器
npm run local:up        # = docker compose up -d && npm run dev

# 5. 初始化数据库 Schema 与演示数据（另开终端）
npm run db:push                                   # 原型阶段推送 Schema
npx tsx scripts/db-smoke.ts                       # 数据库冒烟验证
npx tsx scripts/seed-demo-data.ts                 # 经营指标 / 投放数据种子
npx tsx scripts/seed-acquisition-data.ts          # 买量渠道 / 计划种子
npx tsx scripts/agent-smoke.ts                    # 模型网关连通性验证

# 6. 打开 http://localhost:3100 → 未登录会自动跳到 Access 统一认证页
#    真实环境账号：Access 平台已开通且有 cause entitlement 的账号（如本地 bootstrap 的管理员）
#    模拟器账号：dev / dev-password（有 cause 权限）；viewer / viewer-password（无权限，测 403）
```

### 常用命令

```bash
npm run dev            # 开发服务器          npm run build      # 生产构建
npm run typecheck      # 类型检查            npm run lint       # ESLint
npm run test           # Vitest 全量测试     npm run test:watch # watch 模式
npm run db:migrate     # 创建并应用迁移      npm run db:studio  # Prisma Studio
npm run i18n:check     # 国际化键值检查      npm run local:down # 停止本地依赖
```

## API 概览

所有路由挂载于 `/api/v1`，遵循统一运行时模板（身份校验 → Zod 校验 → 业务逻辑 → `handleApiError` 统一错误）：

| 端点 | 说明 |
|------|------|
| `POST /ask` | 创建问答并运行多 Agent 工作流（SSE 流式） |
| `POST /research` | 发起深度研究任务（SSE 流式，maxDuration 600s） |
| `/insights` 系列 | 洞察画布 CRUD、绑定管理、立即投递、PNG 导出 |
| `/datasources` 系列 | 数据源 CRUD、连接测试、表列表、数据预览 |
| `/semantic/*` | 语义模型管理、自然语言 → SemanticQuery 转译 |
| `/operators` | 算子列表（按分类分组） |
| `/schedules` 系列 | 定时任务 CRUD、立即扫描执行到期任务 |

完整路由清单见 [doc/codewiki.md § 4](doc/codewiki.md)。

## 开发状态

- **已完成**：问答三路径路由与多轮上下文压缩、深度研究算子化链路（SearchOp / ExtractOp / CompareOp）、洞察画布与实时数据绑定、数据源 / 语义层 / 算子管理、定时邮件与图片投递、80 个单元测试全绿、类型检查与 ESLint 零告警
- **预留/待实施**：企业 SSO 认证（当前 `requireActor` 为开发桩）、看板拖拽深度集成、日报生成逻辑、审计日志面板、Redis 缓存、消息队列异步任务、E2E 测试

详细进展见 [doc/开发进度20260827.md](doc/开发进度20260827.md)。

## 文档索引

| 文档 | 内容 |
|------|------|
| [doc/design.md](doc/design.md) | 归因模块详细设计（权威规格：架构、数据模型、护栏体系、部署） |
| [doc/codewiki.md](doc/codewiki.md) | 代码库架构 Wiki（所有结论回链具体文件与行号） |
| [doc/detail.md](doc/detail.md) / [doc/usercase.md](doc/usercase.md) | 细化设计与用户用例 |
| [doc/画布设计.md](doc/画布设计.md) / [doc/问答画布链路打通设计.md](doc/问答画布链路打通设计.md) | 洞察画布与问答→画布链路设计 |
| [doc/数据源API和MCP的设计.md](doc/数据源API和MCP的设计.md) | 数据源 API 与 MCP 接入设计 |
| [doc/开发进度*.md](doc/) | 每日开发进度总结 |
