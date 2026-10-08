# 归因模块（pt-ai-acquisition-cause）

面向企业内部的**数据驱动决策工具**，聚焦流量投放效果归因场景：提供一站式的数据接入、语义统一、自然语言问答、自动化洞察画布与深度研究能力。系统不是面向公众的 Demo，按企业级安全、合规、可审计、可运维、可扩展要求设计。

> 权威设计规格见 [doc/design.md](doc/design.md)，代码库架构详解见 [doc/codewiki.md](doc/codewiki.md)，
> 生产部署见 [doc/deploy.md](doc/deploy.md)（前置：[prepare](doc/prepare.md) → [install](doc/install.md)，凭据：[deploy-update](doc/deploy-update.md)）。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 自然语言问答 | 中文提问，自动路由到「直接回答 / 数据分析 / 深度研究」三条路径，SSE 流式展示 Agent 每一步动作 |
| 深度研究 | Planner 拆解子问题 → SearchOp 检索 / ExtractOp 深读 → CompareOp 多源交叉比对（analyzing 阶段）→ 流式生成带引用溯源的研究报告 |
| 研究知识图谱 | 从研究报告抽取实体/关系落盘为 JSON 图谱（`data/research-graph/`），跨报告累积、可全量重建，前端 GraphPanel 可视化 |
| 洞察画布 | 基于 tldraw 无限画布，整合原报告 / 看板 / 日报三模块为 InsightDoc，支持实时数据绑定与 PNG 导出 |
| 数据源接入 | 内置演示 PG 库 + 互联网检索；自定义支持 BI（PostgreSQL）/ API（REST/GraphQL）/ MCP 服务 |
| Adjust 数据同步 | 对接 Adjust Reporting Service API，按「日 × network × country_code × os_name × campaign_network」5 维 16 指标全列同步入库，分日切片防超时、幂等 upsert、429 指数退避 |
| 统一语义层 | 指标字典 + 语义模型 CRUD，自然语言转译为 SemanticQuery 再转 SQL，口径统一、可校验 |
| 算子层 | 数据分析算子（SQL 引擎）+ 研究算子（LLM 引擎）统一注册，工作流「算子优先」调度 |
| 定时投递 | 对洞察文档执行定时邮件 / 图片导出，由 `POST /api/v1/schedules/run` + 外部 cron 驱动 |
| 统一认证 | OIDC BFF 接入 PT AI Access：登录期 Entry Gate 授权 + 请求期 principal 复核（fail-closed），撤权即时生效 |

## 技术栈

| 维度 | 选型 |
|------|------|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript 5（严格模式、ESM Only） |
| 样式/UI | Tailwind CSS 4 + Radix UI + lucide-react |
| 状态/数据 | Zustand（客户端状态）+ SWR（服务端数据）|
| AI 编排 | LangGraph 1.x（Supervisor 多 Agent 状态图）+ LangChain |
| 模型接入 | OpenAI SDK（兼容协议），统一模型网关，主备自动降级 |
| 数据层 | Prisma 7 + @prisma/adapter-pg + PostgreSQL 17（pgvector）；业务表在 `cause` schema，取数表在 `data` schema |
| 可视化 | Recharts（图表）+ tldraw 5（洞察画布）|
| 校验 | Zod 4（所有外部输入：请求体 / 环境变量 / 算子参数）|
| 测试 | Vitest（184 个用例，14 个测试文件）|
| 运行时 | Node.js 24.7.0（nvm 管理，`.npmrc` engine-strict）|
| 部署 | Docker（`node:24-bookworm-slim` 基座，arm64 原生构建）+ Compose profile 隔离 + ALB |

## 架构分层

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层  app/(dashboard)/  问答 / 研究 / 画布 / 数据源 / 语义层 │
├──────────────────────────────────────────────────────────────┤
│ API 层  app/api/v1/  REST + SSE / Zod 校验 / 统一运行时       │
│         app/api/auth/  OIDC BFF 端点                          │
│         app/api/health{,/ready,/live}  存活与就绪探针         │
├──────────────────────────────────────────────────────────────┤
│ 服务层  lib/server/                                           │
│   agents/        Supervisor 多 Agent + 深度研究工作流          │
│   operators/     数据分析算子 + 研究算子（注册表调度）          │
│   semantic/      SemanticQuery 建模与 SQL 转译                 │
│   connectors/    PG / API / MCP / Web / CSV 数据源连接器        │
│   integrations/  Adjust 同步（adjust-sync）+ API 落库（ingest）│
│   research-graph/ 研究知识图谱抽取 / 存取 / 查询 / 复核        │
│   insights/      洞察画布服务（快照 / 绑定 / 抽取）            │
│   delivery/      邮件 / 图片投递 + 定时调度                    │
│   auth/          OIDC BFF（oidc / access-client / session）    │
│   model-gateway.ts  统一模型网关（主备降级）                   │
├──────────────────────────────────────────────────────────────┤
│ 数据层  prisma/schema.prisma（16 个模型，cause schema）        │
│         data schema（adjust_daily_metrics 等取数表，原生 SQL） │
│         PostgreSQL 17 + pgvector / Redis（预留）               │
├──────────────────────────────────────────────────────────────┤
│ 文件态  data/research-graph（图谱）/ public/exports（导出图）  │
│         .deliveries（投递记录）——生产由 bind mount 落数据盘    │
└──────────────────────────────────────────────────────────────┘
```

关键设计原则：

1. **统一模型边界**——所有 AI 调用经 `lib/server/model-gateway.ts`，禁止业务代码直连模型 SDK
2. **算子优先**——标准分析动作先调算子（`runOperator`），算子无法表达时退回 SQL
3. **Schema 优先**——所有外部输入 Zod 校验，fail fast
4. **安全默认**——响应附加安全头，SQL 只读白名单，标识符净化
5. **身份不落前端**——OIDC BFF 模式：ID Token 只留服务端，浏览器仅持 httpOnly 不透明会话
   cookie；授权由 Access 实时判定（登录期 Entry Gate + 请求期 principal 复核，fail-closed）
6. **SSE 流式**——问答 / 研究全程事件推送，前端完整还原 Agent 执行过程
7. **文件态收敛**——进程内文件状态仅三处（研究图谱 / 导出图 / 投递记录），生产 bind mount
   到数据盘；图谱是派生物，损坏可经 `POST /api/v1/research/graph/rebuild` 全量重建
8. **中文注释**——所有代码注释使用中文

## 目录结构

```
pt-ai-acquisition-cause/
├── app/
│   ├── (dashboard)/          # 工作台路由组（侧边栏 + 顶栏布局）
│   │   ├── ask/              # 任务问答（流式 AI 回答）
│   │   ├── research/         # 深度研究（含知识图谱面板）
│   │   ├── insights/         # 洞察画布（列表 / 详情 / 画布编辑器）
│   │   ├── datasources/      # 数据源管理
│   │   ├── semantic/         # 语义层管理
│   │   ├── operators/        # 算子管理
│   │   └── session-watch.tsx # 会话活性监测（失效即重新登录）
│   ├── api/v1/               # REST API（ask / research / insights / datasources / metrics /
│   │                         #   semantic / operators / schedules / syncs / dashboard）
│   ├── api/auth/             # OIDC BFF 端点（login / callback / logout / session）
│   ├── api/health/           # 健康探针（/ /ready /live）
│   └── login/                # 登录页（授权状态机：已登录 / 自动发起 / 已登出 / 授权失败）
├── lib/
│   ├── server/               # 服务端核心（agents / connectors / operators / semantic /
│   │                         #   integrations / research-graph / insights / delivery / auth
│   │                         #   + 模型网关 / SSE / 调度器）
│   ├── db/                   # Prisma 客户端单例与生成代码
│   └── env.ts                # 环境变量 Zod 校验
├── components/               # AgentTimeline / MarkdownView / ChartRenderer / DataTable /
│                             #   画布组件 / GraphPanel
├── hooks/use-agent-stream.ts # Agent SSE 流消费 Hook
├── prisma/schema.prisma      # 数据模型（16 个模型，含 AuthSession / OidcTransaction）
├── scripts/                  # 冒烟测试 / 数据种子 / Adjust 同步 / 发布打包等运维脚本
├── tests/                    # Vitest 单元测试（14 个文件）
├── Dockerfile                # 应用镜像（node:24-bookworm-slim，node 用户运行）
├── docker-compose.yml        # 一个文件两用：本地只起 postgres，生产 COMPOSE_PROFILES=app 起全栈
└── doc/                      # 设计文档 + 部署运维手册（见「文档索引」）
```

## 快速开始

### 前置条件

- Node.js 24.7.0（nvm 管理；`.npmrc` 开了 engine-strict，版本不符会直接装不上）
- Docker（本地跑 PostgreSQL 17 + pgvector；Redis 仅预留，compose 未启服务）
- 一个 OpenAI 兼容的模型 API（BASE_URL / API_KEY / 模型名）——启动必填，`lib/env.ts` 会 fail-fast
- 可选：Adjust API Token（`ADJUST_API_TOKEN`），仅 Adjust 数据同步与算子 API 直查需要
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
# 编辑 .env：必填 AUTH_SECRET（≥32 字符）/ MODEL_GATEWAY_BASE_URL / MODEL_GATEWAY_API_KEY /
# MODEL_GATEWAY_DEFAULT_MODEL / DATABASE_URL（缺任一项启动即被 lib/env.ts 的 Zod 校验拦下）；
# OIDC_* / ACCESS_* 默认值同时适配本地 pt-access 模拟器与 pt-ai-platform-access 真实环境

# 3. 启动 Access（另开终端，保持运行）——二选一
bash ../pt-ai-platform-access/start-access.sh   # 真实环境（需先起 Keycloak :8094）
node ../pt-access/server.mjs                    # 或轻量模拟器（自带 identity :8094 + access :4300）

# 4. 启动本地依赖并运行开发服务器
npm run local:up        # = docker compose up -d && npm run dev

# 5. 初始化数据库 Schema 与演示数据（另开终端）
npm run db:push                                   # 原型阶段推送 cause schema
npx tsx scripts/db-smoke.ts                       # 数据库冒烟验证
npx tsx scripts/seed-demo-data.ts                 # 经营指标 / 投放数据种子（data schema）
npx tsx scripts/seed-acquisition-data.ts          # 买量渠道 / 计划种子（data schema）
npx tsx scripts/agent-smoke.ts                    # 模型网关连通性验证

# 6.（可选）同步 Adjust 投放数据入 data.adjust_daily_metrics（需 ADJUST_API_TOKEN）
npx tsx scripts/sync-adjust-data.ts --days 3      # 回补近 3 天（Adjust T+1，幂等可重跑）
npx tsx scripts/sync-adjust-data.ts --from 2026-05-01 --to 2026-05-31  # 回补绝对日期区间
#   --reset 为清空重建（DROP 后按最新 5 维 DDL 重建），仅 PK 变更 / 首次重同步时用

# 7. 打开 http://localhost:3100 → 未登录会自动跳到 Access 统一认证页
#    真实环境账号：Access 平台已开通且有 cause entitlement 的账号（如本地 bootstrap 的管理员）
#    模拟器账号：dev / dev-password（有 cause 权限）；viewer / viewer-password（无权限，测 403）
```

### 常用命令

```bash
npm run dev            # 开发服务器（:3100）  npm run build      # 生产构建
npm run start          # 生产启动（:3100）    npm run typecheck  # 类型检查
npm run lint           # ESLint               npm run test       # Vitest 全量测试
npm run test:watch     # watch 模式           npm run i18n:check # 国际化键值检查
npm run db:generate    # 生成 Prisma Client   npm run db:push    # 开发环境推送 Schema
npm run db:migrate     # 创建并应用迁移       npm run db:deploy  # 生产仅应用已提交迁移
npm run db:studio      # Prisma Studio        npm run local:up   # 起 postgres + dev
npm run local:down     # 停止本地依赖
```

## 容器化与生产部署

生产为**单台 EC2 同机双容器**形态（`prod-ai-cause-01`，m7g.xlarge / arm64 / ap-southeast-1）：

```text
内网用户 ──HTTPS──▶ ALB (cause.pmdevops.com)
                      │ 目标组 HTTP:3100，健康检查 /api/health
                      ▼
              app 容器 (cause-app, :3100, mem 4g)
                      │ DATABASE_URL host=postgres
                      ▼
              postgres 容器 (pgvector/pgvector:pg17, mem 6g)

外部依赖（均 HTTPS 出站）：模型网关 / PT AI Access(Keycloak) / Adjust API
```

| 要点 | 说明 |
|------|------|
| 镜像 | `Dockerfile` 基于 `node:24-bookworm-slim`，以 `node` 用户（UID 1000）运行，`EXPOSE 3100`；arm64 目标机上原生构建，无需交叉模拟 |
| 构建期占位 env | `next build` 会导入 `lib/env.ts` 做 Zod 校验（fail-fast），故构建层注入可通过校验的占位值；这些值只存在于该 RUN 层，运行时由 `.env` 覆盖 |
| 一个 compose 两用 | 本地不带 profile → 只起 postgres（`local:up` 行为不变）；服务器 `.env` 设 `COMPOSE_PROFILES=app` → 激活全栈 |
| 网络暴露 | postgres 5432 仅绑宿主机回环 `127.0.0.1`（本机调试用），不对实例网卡暴露；app 3100 全接口发布供 ALB 经私网 IP 访问，来源由安全组控制 |
| 数据持久化 | pgdata + 三类业务文件态（`data/research-graph`、`public/exports`、`.deliveries`）在服务器上由 `docker-compose.override.yml`（`!override` 语法，不入库）重定向到 `/srv/cause` 数据盘 |
| 健康探针 | `GET /api/health`（compose healthcheck + ALB 目标组共用）、`/api/health/ready`、`/api/health/live`，均返回 `{"ok":true}` 且不触达数据库 / Access / 模型网关 |
| 代码分发 | 服务器到 GitHub 拉取缓慢，主走 `bash scripts/pack-release.sh` → `dist/cause-release-<git短SHA>.tar.gz` → JumpServer 上传 → 服务器解压；GitHub 仅作版本管理与异地备份 |
| 数据库迁移 | 仓库当前**无** `prisma/migrations/`，本地开发走 `db:push`；生产首次须按 deploy.md 步骤 0 生成 `0_init` 基线迁移并提交，服务器只用 `db:deploy` |

运维手册按执行顺序分为四份（均在 `doc/`）：`prepare.md`（服务器环境采集）→ `install.md`（EC2 软件与依赖安装）→ `deploy.md`（部署命令手册）→ `deploy-update.md`（Access 凭据接入与 `.env` 更新）。

## API 概览

业务路由挂载于 `/api/v1`，遵循统一运行时模板（`requireActor` 身份校验 → Zod 校验 → 业务逻辑 → `handleApiError` 统一错误）：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/ask` | POST / GET | 创建问答并运行多 Agent 工作流（SSE 流式）/ 历史列表 |
| `/ask/[id]` | GET / DELETE | 问答详情 / 删除 |
| `/research` | POST / GET | 发起深度研究任务（SSE 流式，maxDuration 600s）/ 任务列表 |
| `/research/[id]` | GET / DELETE | 研究任务详情 / 删除 |
| `/research/graph` | GET | 研究知识图谱全量数据（供深度研究页 SVG 径向图面板；图谱缺失/损坏时返回空图） |
| `/research/graph/rebuild` | POST | 从既有研究报告全量重建图谱（图谱是派生物，可安全重建） |
| `/insights` | GET / POST | 洞察文档列表 / 创建 |
| `/insights/[id]` | GET / PUT / DELETE | 洞察文档详情 / 更新 / 删除 |
| `/insights/[id]/bindings` | GET / POST | 画布实时数据绑定查询 / 新增 |
| `/insights/bindings/[id]` | GET / DELETE | 单个绑定详情 / 解绑 |
| `/insights/[id]/deliver` | POST | 立即投递（邮件 / 图片） |
| `/insights/[id]/export` | POST | 画布 PNG 导出 |
| `/datasources` | GET / POST | 数据源列表 / 创建 |
| `/datasources/[id]` | PUT / DELETE | 数据源更新 / 删除 |
| `/datasources/[id]/[action]` | GET / POST | 按 action 分派：`test` / `query` / `request` / `graphql` / `invoke` / `agent` / `schema` / `tools` / `preview` |
| `/metrics` | GET / POST | 指标字典分页查询（可按 status 过滤）/ 创建指标 |
| `/semantic/models` | GET / POST | 语义模型列表 / 创建 |
| `/semantic/models/[id]` | GET / PUT / DELETE | 语义模型详情 / 更新 / 删除 |
| `/semantic/translate` | POST | 语义查询试运行：SemanticQueryV1 → SQL 转译 → 只读执行，返回 SQL 与结果集 |
| `/operators` | GET / POST | 算子注册表（含参数 Schema，供 UI 动态渲染表单）/ 算子试运行（真实执行，返回 SQL、结果与耗时） |
| `/schedules` | GET / POST | 定时任务列表 / 创建 |
| `/schedules/[id]` | PUT / DELETE | 定时任务更新 / 删除 |
| `/schedules/run` | POST | 立即扫描并执行到期任务（由外部 cron 驱动） |
| `/syncs/adjust` | POST | 触发 Adjust 同步（入参 `days` 或 `from`/`to`，可选 `reset`） |
| `/dashboard/stats` | GET | 工作台统计 |

鉴权与探针路由不在 `/api/v1` 下，也不经 `requireActor`：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | GET | 发起 OIDC 登录（生成 state/nonce/verifier 并落库） |
| `/api/auth/callback` | GET | OIDC 回调（一次性消费登录事务，换 ID Token） |
| `/api/auth/logout` | POST | 登出并吊销会话 |
| `/api/auth/session` | GET | 前端会话探活 |
| `/api/health`、`/api/health/ready`、`/api/health/live` | GET | 存活 / 就绪探针，返回 `{"ok":true}` |

完整路由清单见 [doc/codewiki.md § 4](doc/codewiki.md)。

## 开发状态

**已完成**

- 问答三路径路由与多轮上下文压缩；深度研究算子化链路（SearchOp / ExtractOp / CompareOp）
- 研究知识图谱（抽取 / 落盘 / 查询 / 全量重建 + 前端径向图面板）
- 洞察画布与实时数据绑定、PNG 导出；数据源 / 语义层 / 算子管理
- 定时邮件与图片投递（外部 cron 驱动）
- **PT AI Access 统一认证已落地**（OIDC BFF：登录期 Entry Gate + 请求期 principal 复核 fail-closed，
  `requireActor` 已是真实鉴权而非开发桩）
- Adjust 数据同步：5 维 16 指标全列入库、相对/绝对区间回补、幂等 upsert、429 指数退避、时区口径统一
- 容器化与生产部署：Dockerfile / compose profile / 发布打包脚本 / 三个健康探针 / EC2 双容器上线手册
- 质量基线：`npm run test` **184 个用例全绿**（14 文件），`npm run typecheck` **零错误**

**已知问题**

- `npm run lint` 当前 **2 errors + 9 warnings**：error 为 `lib/api-fetch.ts` 两处
  `@typescript-eslint/no-explicit-any`；warning 集中在未使用变量与算子 Zod Schema 的类型用法
- `tests/adjust-reporting-api.test.ts` 是**真实网络请求**（非 mock），未配 `ADJUST_API_TOKEN`
  时整组自动跳过；配了 Token 则单文件约 18s

**预留 / 待实施**

- `prisma/migrations/` 尚未入库——生产首次部署须按 deploy.md 步骤 0 生成 `0_init` 基线迁移
- BI 中间表（`data.daily_metrics` / `data.channel_daily_metrics`）自动同步未实现，当前库内 0 行、
  仅由种子脚本定义；`data.adjust_daily_metrics` 则有真实数据（详见 doc/data-review-again.md）
- Adjust 官方 MCP 未对接（官方 Early Access，本账号未开通）
- 看板拖拽深度集成、日报生成逻辑、审计日志面板、Redis 缓存、消息队列异步任务、E2E 测试
- 语义层「落表开关」（模型级 `persistApiResults`）方案已定稿待实施，见 dataflow-Improvement.md

详细进展见 [doc/开发进度20260904.md](doc/开发进度20260904.md)。

## 文档索引

**设计与架构**

| 文档 | 内容 |
|------|------|
| [doc/design.md](doc/design.md) | 归因模块详细设计（权威规格：架构、数据模型、护栏体系、部署） |
| [doc/codewiki.md](doc/codewiki.md) | 代码库架构 Wiki（所有结论回链具体文件与行号） |
| [doc/detail.md](doc/detail.md) / [doc/usercase.md](doc/usercase.md) | 细化设计与用户用例 |
| [doc/画布设计.md](doc/画布设计.md) / [doc/问答画布链路打通设计.md](doc/问答画布链路打通设计.md) | 洞察画布与问答→画布链路设计 |
| [doc/深度研究知识图谱融合设计-Understand-Anything.md](doc/深度研究知识图谱融合设计-Understand-Anything.md) | 研究知识图谱融合设计 |
| [doc/鉴权接入PT-AI-Access设计.md](doc/鉴权接入PT-AI-Access设计.md) | OIDC BFF 鉴权链路设计 |
| [doc/数据源API和MCP的设计.md](doc/数据源API和MCP的设计.md) | 数据源 API 与 MCP 接入设计 |
| [doc/项目规范参考.md](doc/项目规范参考.md) | 技术栈依赖清单 + 编码 / API / 错误处理 / UI 设计规范 |
| [doc/系统架构.png](doc/系统架构.png) / [doc/业务流程.png](doc/业务流程.png) | 架构图与业务流程图 |
| [doc/business-data-flow.html](doc/business-data-flow.html) | 业务数据流交互图 |

**数据与取数**

| 文档 | 内容 |
|------|------|
| [doc/functions.md](doc/functions.md) | 数据取数与落库六类通路详解（API 直查 / 本地表 SQL / 写库） |
| [doc/api-metrics-glossary.md](doc/api-metrics-glossary.md) | 指标口径词典 |
| [doc/data-review.md](doc/data-review.md) / [doc/data-review-again.md](doc/data-review-again.md) | 三张核心表字段注解与维度互补性复审 |
| [doc/Adjust官网API与MCP对接指南-20260902.md](doc/Adjust官网API与MCP对接指南-20260902.md) | Adjust Reporting Service API 对接指南 |
| [doc/Adjust官网使用方式与结果总结-20260902.md](doc/Adjust官网使用方式与结果总结-20260902.md) / [doc/Adjust官网使用情况评估与价值分析-20260902.md](doc/Adjust官网使用情况评估与价值分析-20260902.md) | Adjust 平台实际使用探索与价值评估 |
| [doc/adjust-metrics-optimization-plan.md](doc/adjust-metrics-optimization-plan.md) | Adjust 指标优化方案 |
| [dataflow-Improvement.md](dataflow-Improvement.md) | 语义层「落表开关」方案（根目录） |

**部署与运维**（按执行顺序）

| 文档 | 内容 |
|------|------|
| [doc/prepare.md](doc/prepare.md) | EC2 部署前环境采集清单（含 2026-09-29 实际采集结果） |
| [doc/install.md](doc/install.md) | EC2 软件与依赖安装清单（git / Compose v2 / 数据盘 / swap / 日志轮转） |
| [doc/deploy.md](doc/deploy.md) | 生产部署命令手册（基线迁移、代码分发、compose 启动、ALB 注册） |
| [doc/deploy-update.md](doc/deploy-update.md) | Access 凭据接入与 `.env` 更新手册（deploy.md 步骤 9 展开版） |
| [doc/02-PT-AI首次上线AWS资源申请清单-Cause补充-v1.0.html](doc/02-PT-AI首次上线AWS资源申请清单-Cause补充-v1.0.html) | AWS 资源申请清单 |

**进度记录**

| 文档 | 内容 |
|------|------|
| [doc/开发进度*.md](doc/) | 每日开发进度总结（20260825 ~ 20260904） |
| [doc/research-improvement.md](doc/research-improvement.md) | 深度研究链路改进记录 |
