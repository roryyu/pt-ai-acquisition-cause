@AGENTS.md

# 归因模块 — CLAUDE.md

## 项目概述

归因模块（pt-ai-acquisition-cause）：面向企业内部的数据驱动决策工具，提供自然语言问答、洞察报告、看板监控、日报生成等核心功能。

**唯一规范来源**：`doc/design.md`。所有实现决策严格遵循该文档，不参考 workspace 内其他项目。

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 框架 | Next.js (App Router) | 16.3.2 |
| 运行时 | React | 19.2.8 |
| 语言 | TypeScript (strict) | 5.9 |
| 样式 | Tailwind CSS v4 | @tailwindcss/postcss |
| ORM | Prisma 7 + @prisma/adapter-pg | 7.9.1 (exact) |
| 验证 | Zod | 4.x |
| 状态 | Zustand + SWR | |
| AI | OpenAI SDK (兼容协议) | 7.x |
| 图表 | Recharts | 3.x |
| 图标 | lucide-react | |

## 环境要求

- **Node.js**: v24.7.0（nvm 管理）
- **PostgreSQL**: 本地运行，schema = `cause`
- **非交互 shell**: 使用 `source ~/.nvm/nvm.sh && nvm use 24.7.0` 或 `export PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH"`

## 开发命令

```bash
npm run dev          # 启动开发服务器
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run test         # Vitest 测试
npm run db:generate  # 重新生成 Prisma 客户端
npm run db:push      # 推送 Schema 到数据库
npm run db:studio    # Prisma Studio
npx tsx scripts/db-smoke.ts  # 数据库冒烟测试
```

## 项目结构

```
app/
├── (dashboard)/         # 工作台路由组（含侧边栏布局）
│   ├── page.tsx         # 工作台首页 → client.tsx
│   ├── sidebar.tsx      # 侧边栏导航（客户端）
│   ├── topbar.tsx       # 顶栏搜索/通知（客户端）
│   ├── ask/             # 任务问答（流式 AI 回答）
│   ├── reports/         # 洞察报告（CRUD + 编辑）
│   ├── boards/          # 看板（卡片管理）
│   └── digests/         # 日报中心
├── api/v1/              # REST API
│   ├── ask/             # 问答（POST=流式，GET=列表）
│   ├── reports/         # 报告 CRUD
│   ├── boards/          # 看板 CRUD + 卡片
│   ├── digests/         # 日报 CRUD
│   ├── metrics/         # 指标管理
│   └── dashboard/stats/ # 工作台统计
├── login/               # 登录页（开发桩）
├── layout.tsx           # 根布局
└── globals.css          # 设计系统变量
lib/
├── db/                  # Prisma 客户端（adapter-pg 单例）
├── server/
│   ├── api-runtime.ts   # ApiError / ok / readJson / requireActor / handleApiError
│   ├── model-gateway.ts # 统一模型网关（OpenAI 兼容协议）
│   └── ids.ts           # newId(prefix) → prefix_uuid
├── env.ts               # 环境变量 Zod 校验
└── utils.ts             # cn() 类名合并
prisma/
└── schema.prisma        # 数据模型（cause schema）
```

## 编码规范

### 命名
- 组件：PascalCase，文件名 kebab-case
- 函数/变量：camelCase
- 常量：UPPER_SNAKE_CASE
- Zod Schema：PascalCase + Schema 后缀
- ID 前缀：`prefix_uuid`（使用 `newId("question")`）

### API 路由模板
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

### 页面结构
- `page.tsx`：服务端组件（导出 metadata + 渲染 client）
- `client.tsx`：客户端组件（`"use client"` + 交互逻辑）

### 样式
- CSS 变量定义在 `globals.css`
- 使用 Tailwind 实用类 + `style` 内联 CSS 变量
- 客户端组件使用 `cn()` 合并类名

### 注释
- **所有代码注释必须使用中文**

## Prisma 技能参考

项目 `.agents/skills/` 目录包含 Prisma 相关技能文档：
- `prisma-cli/` — Prisma CLI 命令参考
- `prisma-client-api/` — Prisma Client API 参考
- `prisma-database-setup/` — 数据库配置指南
- `prisma-postgres/` — PostgreSQL 特定功能

使用 Prisma 相关操作时可查阅这些技能文档。

## 关键设计决策

1. **统一模型边界**：所有 AI 调用经 `lib/server/model-gateway.ts`
2. **Adapter 可替换**：数据源、身份、存储通过 Adapter 模式支持多后端
3. **Schema 优先**：所有外部输入使用 Zod 校验
4. **安全默认**：响应附加安全头（next.config.ts）
5. **ESM Only**：`"type": "module"`
6. **Prisma 7**：schema.prisma 无 url，prisma.config.ts 提供，运行时 PrismaPg 显式传 schema

## 开发进度

### ✅ 第一版已完成
- [x] Prisma Schema：用户/权限/语义层/任务/报告/看板/日报/审计
- [x] 共享服务端基础设施（api-runtime / model-gateway / ids）
- [x] 全部 API 路由（CRUD + 流式问答 SSE）
- [x] Dashboard 布局（侧边栏 + 顶栏）
- [x] 工作台首页（统计/最近提问/最近报告/快捷入口）
- [x] 任务问答（自然语言输入/流式 AI 回答/历史记录）
- [x] 洞察报告（列表/创建/详情/编辑/发布/删除）
- [x] 看板（列表/创建/详情/卡片管理/删除）
- [x] 日报中心（列表/创建/预览/删除）
- [x] 登录页（开发桩，后续接入 SSO）
- [x] 全局样式系统（CSS 变量/状态灯/焦点环/滚动条）

### 📋 后续迭代
- [ ] 语义层管理界面（指标字典/数据源/血缘）
- [ ] 多 Agent 深度研究引擎（Supervisor/DataWorker/ResearchWorker/Critic）
- [ ] 看板拖拽布局（@dnd-kit）
- [ ] 图表可视化（Recharts 集成）
- [ ] 日报定时生成与推送
- [ ] 企业 SSO / OAuth2.1 认证
- [ ] 审计日志查看面板
- [ ] MCP Gateway / Web 抓取集成
- [ ] 国际化（en / zh-CN）
- [ ] 单元测试 + E2E 测试
