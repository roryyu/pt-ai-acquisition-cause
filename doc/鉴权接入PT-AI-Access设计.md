# 归因模块鉴权接入 PT AI Access 详细设计

> 状态：待评审
> 日期：2026-09-15
> 范围：`pt-ai-platform-access`（认证平台侧）+ `pt-ai-acquisition-cause`（归因模块侧）

---

## 1. 背景与目标

### 1.1 背景

归因模块当前的鉴权是**开发桩**：

- `lib/server/api-runtime.ts` 的 `requireActor()` 返回硬编码模拟用户（`user_dev_default`）；
- `app/login/client.tsx` 模拟登录，任意输入直接跳转工作台；
- `AUTH_SECRET` 已配置但未被使用；User / Workspace / Permission 表已建但未启用。

同时，PT AI 平台已有统一认证体系 **PT AI Access**（`pt-ai-platform-access` 仓库）：

- 共享 Keycloak Realm（`pt-ai`，本地 `http://localhost:8094`）负责人员认证（OIDC Authorization Code + PKCE）；
- Access BFF（本地 `http://localhost:4300`）负责账号开通、应用入口授权（Entry Entitlement）、审计与用户目录；
- 已接入 4 个应用：Portal（4200）、Access 自身（4300）、Creative（3000）、Foundation（4173）。

### 1.2 目标

把归因模块作为**第 5 个应用**接入 Access 统一认证：

1. 人员认证统一走共享 Identity（Keycloak），归因模块不再有自己的账号密码体系；
2. 应用入口授权（能否进入归因模块）由 Access 的 Entitlement 统一管理；
3. `requireActor()` 从桩实现改为真实会话校验，**27 个调用点零改动**（返回结构保持 `{ id, name, email, role }`）；
4. 登录 / 登出 / 会话过期 / 401 恢复全链路可用，契约对齐四应用认证基线。

### 1.3 非目标（本期不做）

- 角色快照推送（`/internal/agent-role-snapshots`，二期可选）；
- 分层会话策略（`SESSION_POLICY_V1_MODE` shadow/enforce，属 Access/Portal 管理端能力）；
- 归因模块内部业务权限模型（Permission 表 / Workspace 隔离）的重构，仍按 doc/design.md 原计划推进；
- 账号切换（`pt.account-switch`，需要 Identity Cookie SPI 配合）。

---

## 2. 现状盘点（调查结论）

### 2.1 PT AI Access 侧关键事实

| 项 | 事实 |
| --- | --- |
| 认证协议 | OIDC Authorization Code + PKCE（S256），`directAccessGrantsEnabled=false`，服务端 Session |
| 会话存储 | 各应用自建 `*_sessions` 表（存 session hash），cookie 携带原 token，DB 存哈希 |
| Entry Gate | 登录回调后调 `POST /internal/session-activated {subject, entryId}` 校验 entitlement 并激活；请求期调 `POST /internal/principal {subject, entryId}` 复核 |
| 内部接口认证 | Header `x-pt-access-internal-secret`（本地值 `pt-ai-access-internal-local-only`） |
| Principal 结构 | `{ id, subject, username, usernameDisplay, email, displayName, status, accessRoles, entitlements, agentRoleProjections, ... }`，`email` 可为 null（邮箱可选） |
| 应用注册 | `access_applications` 表（Catalog），本地 fixture 由 `src/store.mjs` 的 `entryCatalog()` 提供，生产用 `npm run catalog:apply --file <json>` |
| Client 注册 | `infra/keycloak/pt-ai-realm.json`（首次导入）+ `infra/keycloak/reconcile-realm.mjs`（已有 realm 的协调更新，注意**重新导入 realm JSON 不会更新既有 realm**） |
| 职责边界 | Access 管「能否进入」（entitlement），应用管「进入后能做什么」（原生角色） |

内部接口契约（`pt-ai-platform-access/src/server.mjs`）：

| 端点 | 请求体 | 成功响应 | 失败语义 |
| --- | --- | --- | --- |
| `POST /internal/principal` | `{ subject, entryId? }` | `{ principal }` | 403 `account_not_provisioned` / `account_disabled` / `account_not_active` / `entry_entitlement_required` |
| `POST /internal/session-activated` | `{ subject, entryId? }` | `{ principal }` | 同上；成功会 `markAuthenticated`（pending_password_change→active）+ 记录最近使用应用 + 审计 |
| `POST /internal/directory` | `{ subject, locale }` | `{ entries }` | Portal 应用目录来源 |
| `POST /internal/agent-role-snapshots` | `{ agentId, subject, assignmentVersion, eventId, roles[], occurredAt }` | `{ outcome, assignmentVersion }` | 二期可选 |

### 2.2 归因模块侧关键事实

| 项 | 事实 |
| --- | --- |
| 桩位置 | `lib/server/api-runtime.ts` L48-L61 `requireActor()`；`app/login/client.tsx` 模拟登录 |
| 调用面 | 27 个文件调用 `requireActor`；业务代码仅使用 `actor.id`（15 处）、`actor.name`（3 处）、`actor.email`（3 处），**`actor.role` 未被业务代码消费** |
| 用户 JIT | `app/api/v1/ask/route.ts`、`app/api/v1/research/route.ts` 已有 `ensureUser(actor.id)` 惰性建户逻辑（`lib/server/user.ts`） |
| User 模型 | `id`（主键，现为 `user_xxx` 自由格式）、`email @unique`、`name`、`role @default(viewer)` |
| 审计 | `AuditLog` 表已存在，`AuditAction` 枚举已含 `login` / `logout`，未使用 |
| 中间件 | 无 `middleware.ts`（鉴权全在 route handler 内） |
| 端口 | `.env` 中 `APP_URL=http://localhost:3000` —— **与 Creative 冲突**（Creative 的 Keycloak client 已注册 `localhost:3000/*`） |
| 技术栈 | Next.js 16 App Router（Node runtime）+ Prisma 7（schema=`cause`）+ Zod 4 + Vitest（80 用例基线全绿） |

---

## 3. 总体方案

### 3.1 架构拓扑

```
                         ┌──────────────────────────────────────────────────┐
                         │  pt-ai-platform-access compose（资源组 pt-ai-access）│
                         │                                                  │
  浏览器                  │  ┌──────────┐   ┌──────────────────────────┐    │
    │                    │  │ identity │   │ access-app (BFF, :4300)  │    │
    │  ① OIDC 登录        │  │ Keycloak │   │  账号/Entitlement/审计    │    │
    ├───────────────────>│  │ :8094    │   │  /internal/* 接口         │    │
    │                    │  └──────────┘   └──────────┬───────────────┘    │
    │  ② 业务请求(cookie)  │       │                     │ access-data(PG)   │
    ├───────────────────>│  └─────┼─────────────────────┼────────────────────┘
    │                    │        │                     │
    ▼                    │        │                ③ /internal/principal
┌────────────────────┐   │        │                     │（60s 缓存 + fail-closed）
│ cause (Next.js     │   │        │                     ▼
│ BFF, :3100)        │───┼────────┘        ┌──────────────────────┐
│ /api/auth/*        │   └─────────────────│ Access DB (:5432)     │
│ /api/v1/*          │                     │ pt_ai_access / pt_ai_ │
│  requireActor()    │                     │ keycloak 库            │
└─────────┬──────────┘                     └──────────────────────┘
          │
          ▼
   cause PG（本地自装, schema=cause）
   users / auth_sessions / oidc_transactions
```

- **浏览器 ↔ Keycloak**：标准 OIDC 授权码流，浏览器最终只持有一个 `pt_cause_session` httpOnly cookie，**不接触任何 token**；
- **cause BFF ↔ Access**：回调时一次 `/internal/session-activated`（Entry Gate），请求期 `/internal/principal` 复核（短缓存）；
- **归因模块数据库不变**：仍是本地 PG 的 `cause` schema，新增会话/事务两张表，`User` 表语义升级。

### 3.2 关键决策

| # | 决策 | 理由 | 备选（及不采用原因） |
| --- | --- | --- | --- |
| D1 | **BFF 模式**（服务端 Session），浏览器零 token | 四应用统一基线；SSE（ask/research）天然带 cookie；无 token 泄露面 | SPA + Bearer token：与基线不符，EventSource/刷新/存储都更复杂 |
| D2 | **自研轻量 OIDC 客户端**（`jose` 验签），契约对齐 `@pt-ai/bff-auth` | 归因模块是独立仓库，不受 pt-ai-workspace 治理；`bff-auth` 的 `appId` 类型是 `"access"\|"portal"\|"foundation"\|"creative"` 硬编码枚举，新增 `"cause"` 需 Workspace 升级发版（0.8.0 tgz）；自研面很小（一个授权码流 ≈ 300 行） | 消费 `@pt-ai/bff-auth` tgz：组织上要求「统一认证基线 / 分层会话策略」时再做（见 §13 开放问题 Q1），届时切换成本可控 |
| D3 | 命名：**entryId=`cause`**、Keycloak clientId=**`pt-ai-cause`**、cookie=**`pt_cause_session`**、session 表=`auth_sessions` | 与 `portal/access/creative/foundation` 同风格（单词小写） | `acquisition-cause`：冗长；`insight`：与产品名混淆 |
| D4 | 本地端口 **3100** | 3000 已被 Creative 注册（realm client redirectUris）且常驻；3100 避开全部已占用端口（3000/4173/4200/4300/8094） | — |
| D5 | **`User.id = Access subject`**（Keycloak UUID），登录时 JIT upsert | `ensureUser(actor.id)` 等 15 处 `actor.id` 消费点零改动；subject 是全平台稳定唯一键 | 独立 `user_xxx` + `subject` 字段：多一次间接查询，无收益 |
| D6 | 请求期 Entry Gate：`/internal/principal` + **60s 进程内缓存 + fail-closed** | 对齐 Access 基线（「应用仍须通过 Access 校验账号状态和应用授权」）；60s 与 bff-auth Identity checker 缓存口径一致；Access 不可达时返回可重试 503 而非放行 | 每请求直查：给 Access 增加无谓 QPS；登录时一次校验后不再复核：停用账号可继续用满 10h，不符合基线 |
| D7 | 业务角色（admin/analyst/operator/viewer）**保留在 cause 自管**，与 Access 解耦 | Access 官方边界：「Access 管入口，应用管原生角色」；角色快照推送是只读展示，不是权限计算 | 用 `accessRoles` 映射：`accessRoles` 只有 `access.admin`，语义不符 |

---

## 4. Access / Identity 侧改造（pt-ai-platform-access 仓库）

> 共 6 处改动，均为「注册第 5 个应用」的常规装配，不触碰 Access 核心鉴权逻辑。

### 4.1 `infra/keycloak/pt-ai-realm.json` — 新增 OIDC client

在 `clients` 数组追加（对齐 `pt-ai-portal` 的 confidential client 模式）：

```json
{
  "clientId": "pt-ai-cause",
  "name": "PT AI Cause",
  "enabled": true,
  "publicClient": false,
  "secret": "pt-ai-cause-oidc-local-only",
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "redirectUris": ["http://localhost:3100/*", "http://127.0.0.1:3100/*"],
  "webOrigins": ["http://localhost:3100", "http://127.0.0.1:3100"],
  "defaultClientScopes": ["web-origins", "acr", "profile", "roles", "basic", "email"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "pt.account-switch.enabled": "true",
    "post.logout.redirect.uris": "http://localhost:3100/*##http://127.0.0.1:3100/*"
  }
}
```

要点：`publicClient=false` + secret（服务端兑换 token 需要）；PKCE 强制 S256（与四应用一致）；关闭密码直登。

### 4.2 `infra/keycloak/reconcile-realm.mjs` — 协调已有 realm

已有 realm **不会**因重新导入 JSON 更新，必须修改协调脚本：

```js
// applicationOrigins 新增：
"pt-ai-cause": requireEnvironment("CAUSE_APP_BASE_URL"),
// peopleClientIds 新增：
const peopleClientIds = ["pt-ai-portal", "pt-ai-access", "pt-ai-creative", "ai-foundation-console", "pt-ai-cause"];
```

`reconcile-production.mjs` 同步增加 cause 的 origin 装配（生产用真实域名）。

### 4.3 `compose.yaml`

1. `identity-config` 服务 environment 新增：

```yaml
CAUSE_APP_BASE_URL: ${CAUSE_APP_BASE_URL:-http://localhost:3100}
```

2. `dev-fixtures` profile 的 `access-local-bootstrap-admin` 命令中 `--entitlements` 追加 `cause`：

```
--entitlements portal,access,creative,foundation,cause
```

（本地 Access Admin 因此默认能进入归因模块，便于联调。）

### 4.4 `src/store.mjs` — `entryCatalog()` 新增条目（本地 fixture）

```js
{
  id: "cause",
  entryType: "app",
  icon: "CA",
  tone: "purple",
  name: "归因分析",
  nameEn: "Acquisition Cause",
  description: "数据驱动的流量归因分析与智能决策引擎。",
  descriptionEn: "Data-driven acquisition attribution and decision intelligence.",
  publicationStatus: "published",
  discoveryPolicy: "entitled_only",
  connectionStatus: "connected",
  launchUrl: "http://localhost:3100/api/auth/login?returnTo=/",
  owner: "Innovation Office",
  capabilitiesZh: ["自然语言问答", "深度研究", "洞察画布"],
  capabilitiesEn: ["NL Q&A", "Deep research", "Insight canvas"],
  sortOrder: 50,
}
```

要点：`launchUrl` 指向 cause 的登录入口（Next.js route handler，Creative 同款模式）；`discoveryPolicy: entitled_only`（新应用默认，安全类/分析类应用不因发布自动公开）。

**生产环境**不使用 fixture，由操作员将等价 JSON 经审核后执行：

```bash
npm run catalog:apply -- --file <approved-catalog-v2.json> \
  --actor-subject <operator> --reason "Add cause application" \
  --correlation-id <change-id>
```

### 4.5 测试更新

`tests/launch-catalog.test.mjs` 等断言「4 个应用」的用例更新为 5 个；`verify-empty-init.mjs` 的 `APPLICATION_CATALOG_EMPTY` 逻辑不受影响（空库仍是受支持状态）。

### 4.6 Access 侧验证

```bash
cd pt-ai-platform-access
npm run typecheck && npm test && npm run test:web && npm run build
docker compose config --quiet
```

---

## 5. 归因模块侧改造（pt-ai-acquisition-cause 仓库）

### 5.1 数据模型（`prisma/schema.prisma` + migration）

```prisma
/// 用户表：id 语义升级为 Access subject（Keycloak UUID）
model User {
  id           String   @id // Access subject（Keycloak user UUID）
  username     String?  // Access 登录名（usernameDisplay，展示用）
  email        String?  @unique // 邮箱可选（Access 侧邮箱为可选字段）
  name         String // 显示名（来自 Access displayName）
  departmentId String?  @map("department_id")
  role         UserRole @default(viewer) // 业务角色，cause 自管
  lastLoginAt  DateTime? @map("last_login_at") @db.Timestamptz(3)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  workspaces    Workspace[]
  questions     Question[]
  insights      InsightDoc[]
  auditLogs     AuditLog[]
  authSessions  AuthSession[]

  @@schema("cause")
  @@map("users")
}

/// 浏览器会话表：只存 token 哈希，cookie 持有原值（防拖库利用）
model AuthSession {
  id           String    @id // sha256(cookie token) 十六进制
  subject      String // 关联 User.id（Access subject）
  displayName  String    @map("display_name")
  email        String?
  idToken      String? // 登出时作 id_token_hint（一次性使用后置空）
  idleSeconds  Int       @default(1800) @map("idle_seconds")
  expiresAt    DateTime  @map("expires_at") @db.Timestamptz(3)
  lastSeenAt   DateTime  @default(now()) @map("last_seen_at") @db.Timestamptz(3)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  user User @relation(fields: [subject], references: [id])

  @@index([subject])
  @@index([expiresAt])
  @@schema("cause")
  @@map("auth_sessions")
}

/// OIDC 登录事务表：state/nonce/PKCE verifier 服务端持有，一次性消费
model OidcTransaction {
  id        String    @id // sha256(state)
  nonce     String
  verifier  String // PKCE code_verifier
  returnTo  String    @map("return_to")
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(3)
  claimedAt DateTime? @map("claimed_at") @db.Timestamptz(3)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([expiresAt])
  @@schema("cause")
  @@map("oidc_transactions")
}
```

迁移说明：

- 会话参数与 realm 对齐：idle 1800s / max 36000s（`ssoSessionIdleTimeout` / `ssoSessionMaxLifespan`）；
- `AuthSession.idToken` 存 ID Token 原文仅用于登出提示，库内敏感度可接受（可替代方案：仅存 `jti`，一期从简）；
- 存量演示库直接重建（`db:push` + seed），`user_dev_default` 桩数据随之废弃；
- 开发环境执行 `npm run db:migrate` 生成迁移并提交 `prisma/migrations`。

### 5.2 新增服务端模块 `lib/server/auth/`

#### `oidc.ts` — OIDC 客户端（约 200 行）

```
- discoverMetadata(issuer)：GET {issuer}/.well-known/openid-configuration，
  进程内缓存（TTL 10min）+ 超时 3s（对齐 bff-auth AUTH_LIMITS.discovery=3000）
- loadJwks(jwksUri)：jose createRemoteJWKSet（内置缓存与轮换）
- buildAuthorizeUrl({ state, nonce, codeChallenge, returnTo })：
  authorization_endpoint + client_id=pt-ai-cause + response_type=code
  + scope="openid profile email" + redirect_uri={APP_URL}/api/auth/callback
  + PKCE S256；只转发服务端白名单参数，不接受浏览器传入的 state/nonce
- exchangeCode(code, verifier)：token endpoint，client_secret_post
- verifyIdToken(idToken, nonce)：jose jwtVerify + 显式校验
  iss（= OIDC_PUBLIC_ISSUER）/ aud（= OIDC_CLIENT_ID）/ exp / iat / nonce
```

新增依赖：`jose@^6`（与 bff-auth 6.2.7 同系）。**不引入** next-auth / keycloak-js。

#### `access-client.ts` — Access 内部接口客户端（约 120 行）

```
- activateEntrySession(subject)：
  POST {ACCESS_INTERNAL_BASE_URL}/internal/session-activated
  body { subject, entryId: "cause" }，header x-pt-access-internal-secret
- fetchPrincipal(subject)：
  POST /internal/principal，body { subject, entryId: "cause" }
- 响应用 Zod Schema 校验（principal 结构见 §2.1），失败抛 ApiError
- 错误映射：403 account_* / entry_entitlement_required → 403 不可重试；
  5xx / 网络错误 → 503 access_unavailable 可重试（fail-closed）
```

#### `session.ts` — 会话管理（约 180 行）

```
- createSession(subject, principal)：随机 32 字节 token → cookie 原值，
  DB 存 sha256(token)；写 AuditLog(login)
- resolveSession(token)：按哈希查表，校验 revoked_at / expires_at /
  last_seen_at + idle_seconds 闲置过期；过期返回明确原因
  （expired / idle_timeout / revoked → 统一 401 session_expired）
- touchSession(id)：节流更新 last_seen_at（距上次 > 60s 才写库）
- revokeSession(id)：置 revoked_at；写 AuditLog(logout)
- principalCache：Map<subject, {principal, fetchedAt}>，TTL 60s；
  命中则跳过 Access 调用；未命中调 fetchPrincipal，
  403 → 同步删除本地 AuthSession（账号停用 / entitlement 撤销即时生效，
  最多 60s 延迟）；Access 不可达 → 抛 503（fail-closed，不降级放行）
- cookie 名 pt_cause_session；属性：HttpOnly、SameSite=Lax、
  Secure（APP_URL 为 https 时）、Path=/、MaxAge=会话 max
```

### 5.3 API 路由 `app/api/auth/`（4 个 route handler，Node runtime）

#### `GET /api/auth/login?returnTo=/xxx`

1. `returnTo` 过 `normalizeReturnTo` 语义校验（仅站内相对路径，拒绝 `//`、协议前缀，防开放重定向）；
2. 生成 `state`（32B）、`nonce`（32B）、`verifier`（64B），`code_challenge = S256(verifier)`；
3. 写 `OidcTransaction`（TTL 10 分钟）+ 下发 `pt_cause_oidc_state` 临时 cookie（HttpOnly、SameSite=Lax、10min、存 state 原值，double-submit 校验用）；
4. 302 跳转 Identity 授权端点。已登录（有效 session）则直接 302 回 `returnTo`。

#### `GET /api/auth/callback?code=...&state=...`

1. 校验 `state`：query 与临时 cookie 一致（防 login CSRF）→ 哈希查 `OidcTransaction` → `claimedAt IS NULL` 且未过期（事务内原子标记 claimed，一次性消费）；
2. `exchangeCode` + `verifyIdToken`（nonce 比对）→ 得到 `subject`；
3. `activateEntrySession(subject)`：403 → 跳转 `/login?error=<code>`（页面对应展示「未开通 / 已停用 / 无权限」文案）；200 → `principal`；
4. upsert `User`（`id=subject`，同步 username/displayName/email/lastLoginAt）；
5. `createSession` → Set-Cookie（session cookie + 清除临时 state cookie）→ 302 `returnTo`。

#### `POST /api/auth/logout`

1. Origin / Referer 同源校验（CSRF）；
2. `revokeSession` → 构建 Identity `end_session_endpoint` URL（带 `id_token_hint` + `post_logout_redirect_uri={APP_URL}/login`）；
3. 清除 session cookie → 302 跳转（Identity 登出确认后回到登录页）。

#### `GET /api/auth/session`

返回 `{ authenticated, principal: { id, name, email, role }, expiresAt }`（供 topbar 与前端会话检查；未登录返回 `authenticated:false`，不触发跳转）。

### 5.4 `requireActor()` 重写（`lib/server/api-runtime.ts`）

签名与返回结构不变，27 个调用点零改动：

```ts
/**
 * 请求身份校验：解析会话 cookie → 本地会话表 → Access principal 复核（60s 缓存）
 * 失败语义：
 * - 无 cookie / 会话过期闲置撤销      → 401 authentication_required | session_expired
 * - 账号停用 / entitlement 撤销      → 403 entry_entitlement_required | account_disabled
 * - Access 不可达（fail-closed）     → 503 access_unavailable（retryable）
 */
export async function requireActor(request: Request): Promise<{
  id: string; name: string; email: string; role: string;
}> {
  const token = readSessionCookie(request);
  if (!token) throw new ApiError(401, "authentication_required", "请先登录");
  const session = await resolveSession(token);          // 本地 DB
  if (!session) throw new ApiError(401, "session_expired", "登录已失效，请重新登录");
  const principal = await resolvePrincipal(session.subject); // 缓存 or Access
  await touchSession(session.id);
  const user = await ensureUser(session.subject, principal); // JIT（沿用 lib/server/user.ts 模式）
  return { id: user.id, name: principal.displayName, email: user.email ?? "", role: user.role };
}
```

SSE 接口（`/ask`、`/research`）：握手期完成一次 `requireActor` 即可，流式期间不中断（cookie 自动携带，与 EventSource 兼容）。

### 5.5 前端改造

| 文件 | 改动 |
| --- | --- |
| `app/login/client.tsx` | 移除模拟登录；改为「使用 PT AI 账号登录」按钮 → `location.href = "/api/auth/login?returnTo=/"`；渲染 `?error=` 的失败文案（未开通 / 已停用 / 无权限 / 服务不可用） |
| `lib/api-fetch.ts` | `apiFetch` 收到 `401` 信封时，跳转 `/api/auth/login?returnTo=<encodeURIComponent(path+search)>`（一次性守卫，避免循环跳转）；`503 access_unavailable` 原样抛给调用方 |
| `app/(dashboard)/topbar.tsx` | User 图标按钮接入 `GET /api/auth/session`：显示 displayName + 角色徽标，菜单含「登出」 |
| `hooks/`（可选） | `useSession()` SWR hook 供布局消费 |

### 5.6 环境变量（`lib/env.ts` / `.env` / `.env.example`）

```bash
# ---------- 认证（新增） ----------
# 共享 Identity 的公开签发者（Keycloak realm）
OIDC_PUBLIC_ISSUER=http://localhost:8094/realms/pt-ai
# 归因模块的 OIDC client（与 Access realm 注册一致）
OIDC_CLIENT_ID=pt-ai-cause
OIDC_CLIENT_SECRET=pt-ai-cause-oidc-local-only
# Access BFF 内部接口（Entry Gate / principal 复核）
ACCESS_INTERNAL_BASE_URL=http://localhost:4300
PT_ACCESS_INTERNAL_SECRET=pt-ai-access-internal-local-only
# 会话参数（与 realm SSO 会话对齐）
SESSION_IDLE_SECONDS=1800
SESSION_MAX_SECONDS=36000
# APP_URL 改为 3100
APP_URL=http://localhost:3100
```

- `AUTH_SECRET` 废弃（不再自签任何凭证，从 `lib/env.ts` 必填项中移除）；
- `lib/env.ts` 用 Zod 追加上述必填项；`package.json` 的 dev 脚本固定 `-p 3100`。

### 5.7 运维脚本

- `scripts/bootstrap-cause-admin.ts`：`--subject <uuid>` 将某用户 `role` 提升为 `admin`（首位业务管理员引导，幂等）；
- `scripts/auth-smoke.ts`：验证 discovery 可达、client 注册存在（`/realms/pt-ai/.well-known/openid-configuration` + 尝试 device 无关的配置断言），本地联调自检用。

### 5.8 审计

- 登录成功：`AuditLog { userId: subject, action: login, resource: "auth", detail: { correlationId } }`；
- 登出：`action: logout`；
- 复用现有 `newId("audit")` 与表结构，不新增表。

---

## 6. 关键时序

### 6.1 登录

```
浏览器                cause BFF(:3100)            Keycloak(:8094)         Access(:4300)
  │ GET /api/auth/login?returnTo=/ask
  │──────────────────────>│
  │                       │ 写 OidcTransaction(state,nonce,verifier,TTL 10min)
  │  Set-Cookie pt_cause_oidc_state=state; 302 authorize?...&code_challenge
  │<──────────────────────│
  │──────────────────────────────────────>│ 用户登录（首次强制 UPDATE_PASSWORD）
  │  302 /api/auth/callback?code&state
  │<──────────────────────────────────────│
  │──────────────────────>│
  │                       │ state 双校验 + 事务一次性消费
  │                       │ token 兑换 + ID Token 验签（iss/aud/exp/nonce）
  │                       │ POST /internal/session-activated {subject, entryId:"cause"}
  │                       │──────────────────────────────────────────────────>│
  │                       │      principal（status=active，entitlements 含 cause）
  │                       │ upsert User + createSession（审计 login）
  │  Set-Cookie pt_cause_session=...; 302 /ask
  │<──────────────────────│
```

### 6.2 业务请求（`requireActor`）

```
浏览器                     cause BFF                          Access
  │ GET /api/v1/insights（自动携带 cookie）
  │──────────────────────────>│
  │                           │ sha256(token) → auth_sessions（未撤销/未过期/未闲置）
  │                           │ principal 缓存命中? ──否──> POST /internal/principal
  │                           │                                   {subject, entryId:"cause"}
  │                           │                          <────── principal / 403 / 503
  │                           │ touch lastSeenAt（>60s 节流）
  │  { ok: true, data } │ 401/403/503 信封
  │<──────────────────────────│
```

### 6.3 登出

```
浏览器 ── POST /api/auth/logout ──> cause BFF
   │ revokeSession（审计 logout）+ 清 cookie
   │ 302 Identity end_session?id_token_hint&post_logout_redirect_uri=/login
   │<────────────────────────────│
   │（Identity 确认）302 {APP_URL}/login
```

---

## 7. 安全设计

| 主题 | 措施 |
| --- | --- |
| Token 暴露面 | 浏览器仅持有 opaque session cookie（HttpOnly + SameSite=Lax + Secure(https)），ID/Access Token 不落浏览器 |
| 拖库防护 | DB 只存 `sha256(token)`；PKCE verifier/nonce 存服务端事务表 |
| Login CSRF / Code 注入 | state 双重校验（cookie double-submit + DB 一次性消费）；nonce 绑定 ID Token |
| 开放重定向 | `returnTo` 仅接受站内相对路径（复用 `normalizeReturnTo` 语义） |
| CSRF（登出等变更） | SameSite=Lax + Origin 同源校验 |
| Fail-closed | Access 不可达 → 503 可重试，绝不放行 |
| 停用即时性 | entitlement/账号状态撤销后最多 60s（缓存 TTL）生效；403 时同步作废本地会话 |
| 密钥 | `OIDC_CLIENT_SECRET` / `PT_ACCESS_INTERNAL_SECRET` 生产由部署平台注入，本地固定值仅限隔离 Compose 环境（对齐 Access 红线） |
| 传输 | 生产强制 HTTPS（cookie Secure 自动启用；Identity/Access 内网调用走内网地址） |
| 既有安全头 | `api-runtime.ts` 的 SECURITY_HEADERS 全部保留，新增路由沿用 |

---

## 8. 本地联调

```bash
# 1. 启动 Access 资源组（Identity + Access + 数据库 + 本地 fixtures）
cd pt-ai-platform-access
docker compose --profile dev-fixtures up -d
#    首次完成后 fixtures 会：建 catalog（5 应用）+ 引导 Access Admin（含 cause entitlement）

# 2. 启动归因模块
cd pt-ai-acquisition-cause
npm run db:migrate          # 新增 auth_sessions / oidc_transactions / users 变更
npm run dev                 # http://localhost:3100

# 3. 联调验证
#    a. 访问 http://localhost:3100 → 跳 Identity 登录
#    b. 用 access.admin@pt.local / Access-Admin-Local-2026! 登录（如需测试普通用户，
#       在 Access 管理台创建账号并勾选 cause entitlement，首登强制改密）
#    c. 回跳工作台；topbar 显示用户名；问答/研究/画布等 API 正常
#    d. Access 管理台停用该账号 → 归因模块请求 60s 内开始 403
#    e. 登出 → 回到登录页，cookie 清除
```

生产部署顺序：Access 侧（realm client + catalog + 密钥注入）→ cause 侧（env + migration + 发布）→ 在 Access 管理台为首批用户开通 `cause` entitlement。

---

## 9. 兼容与迁移

| 项 | 处理 |
| --- | --- |
| 存量 dev 数据 | `user_dev_default` 桩数据废弃；演示库 `db:push`/`db:migrate` + 重建 seed（seed 脚本本就不建 User，无兼容负担） |
| `ensureUser` JIT | 逻辑保留并统一收口进 `requireActor`（ask/research 内重复调用可顺带删除） |
| `actor.role` | 业务代码暂未消费；topbar 展示用，后续语义层权限按 doc/design.md 演进 |
| typecheck / 测试基线 | 现有 80 用例不回归；`npm run typecheck` 零新增错误 |
| 降级/回滚 | cause 侧回滚 = 恢复旧镜像 + 旧迁移（新增表不破坏旧代码）；Access 侧回滚 = 移除 catalog 条目与 client（已发 token 的用户在会话过期后自然失效） |

---

## 10. 测试与验收

### 10.1 单元测试（Vitest，新增约 20 用例）

- `oidc.test.ts`：authorize URL 构造（PKCE/S256、参数白名单）、ID Token 校验失败矩阵（iss/aud/exp/nonce）；
- `session.test.ts`：创建/解析/闲置过期/撤销/节流 touch、cookie 属性；
- `requireActor.test.ts`：无 cookie → 401；过期 → 401 `session_expired`；principal 403 → 403 + 本地会话删除；Access 5xx → 503（mock fetch）；
- `access-client.test.ts`：响应 Zod 校验、错误码映射；
- `login-callback.test.ts`：state 双校验、事务一次性消费、returnTo 净化。

### 10.2 集成验收（本地真实 Keycloak）

1. Access Admin（含 cause entitlement）完整走通：登录 → 工作台 → 各 API → 登出；
2. 无 entitlement 账号：callback 被拒（`entry_entitlement_required`），登录页展示对应文案；
3. 停用账号：60s 内 API 开始 403，本地会话被作废；
4. 首次登录强制改密（UPDATE_PASSWORD）后正确回跳；
5. Access 管理台账号详情可见 cause 的最近使用记录（`session-activated` 生效）；
6. `pt-ai-platform-access`：`npm test`（catalog 5 应用断言）全绿。

---

## 11. 实施阶段

| 阶段 | 内容 | 交付物 | 可独立验收 |
| --- | --- | --- | --- |
| P1 | Access/Identity 注册（§4 全部） | realm client + catalog + fixtures entitlement + Access 测试更新 | Access 管理台出现「归因分析」，Portal 目录（entitled_only）可配置 |
| P2 | cause 登录链路（§5.1–5.3、5.6–5.7） | auth 路由 + Prisma migration + env + smoke 脚本 | 浏览器可完整走通 OIDC 登录/登出 |
| P3 | 鉴权接管 + 前端收尾（§5.4–5.5、5.8） | `requireActor` 真实实现 + apiFetch 401 + topbar/审计 + 单测 | 全量 API 走真实鉴权，验收清单 10.2 全过 |
| P4（可选） | 角色快照推送 | cause 角色（admin/analyst/...）变更时 `POST /internal/agent-role-snapshots`（幂等 eventId + 单调 assignmentVersion） | Access 账号详情展示 cause 原生角色 |

P1 与 P2 可并行开发（P2 联调依赖 P1 的 client 注册）。

---

## 12. 风险与开放问题

| # | 风险 / 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| R1 | **背信道登出缺口**：用户在 Portal/Identity 全局登出后，cause 本地会话最长仍可用至闲置/最长时限（principal 缓存只校验账号状态，不感知 Identity SSO 会话） | 中 | 一期接受（四应用中非管理端同样依赖前端恢复态）；后续如需收紧，接入 Identity session-status 受限 client 做背信道校验（即 bff-auth session-policy enforce 的能力） |
| R2 | bff-auth `appId` 枚举扩展（未来统一基线） | 低 | 如组织要求四应用同源认证栈，由 Workspace 升级 bff-auth 后 cause 切换为消费 tgz；本设计 cookie/路由/错误码已对齐，切换面收敛在 `lib/server/auth/` |
| R3 | Keycloak 单点：Identity 不可用时新登录与 60s 缓存未命中的请求失败 | 低 | fail-closed + 503 重试提示；discovery/JWKS 进程内缓存降低依赖频度 |
| R4 | 演示/离线开发成本：无 Identity 时无法登录 | 低 | 本地 Compose 起 Access 资源组很轻；如确有离线需求，可后续加 `AUTH_DEV_BYPASS`（仅 development 显式开启，默认关闭）——**待评审决策** |
| Q1 | entryId `cause` 与展示名「归因分析 / Acquisition Cause」是否采纳 | — | 待确认 |
| Q2 | 端口 3100 是否与团队其他本地服务冲突 | — | 待确认 |
| Q3 | 生产域名（APP_URL / redirectUris / post_logout）规划 | — | 上线前由部署清单确定 |

---

## 附：改动文件清单汇总

**pt-ai-platform-access**

```
infra/keycloak/pt-ai-realm.json          # +client pt-ai-cause
infra/keycloak/reconcile-realm.mjs       # +origin/+peopleClientIds
infra/keycloak/reconcile-production.mjs  # +生产装配
compose.yaml                             # identity-config env + dev-fixtures entitlements
src/store.mjs                            # entryCatalog() +cause 条目
tests/launch-catalog.test.mjs 等         # 4→5 应用断言
```

**pt-ai-acquisition-cause**

```
prisma/schema.prisma                     # User 变更 + AuthSession + OidcTransaction
prisma/migrations/xxx_auth/              # 迁移
lib/server/auth/oidc.ts                  # 新增
lib/server/auth/access-client.ts         # 新增
lib/server/auth/session.ts               # 新增
lib/server/api-runtime.ts                # requireActor 重写
app/api/auth/login/route.ts              # 新增
app/api/auth/callback/route.ts           # 新增
app/api/auth/logout/route.ts             # 新增
app/api/auth/session/route.ts            # 新增
app/login/client.tsx                     # 模拟登录 → OIDC 入口 + 错误文案
lib/api-fetch.ts                         # 401 → 跳登录；503 透传
app/(dashboard)/topbar.tsx               # 用户信息 + 登出
lib/env.ts / .env / .env.example         # 新增 OIDC/Access/Session 变量，废弃 AUTH_SECRET
package.json                             # dev 端口 3100 + jose 依赖 + bootstrap 脚本
scripts/bootstrap-cause-admin.ts         # 新增
scripts/auth-smoke.ts                    # 新增
tests/auth/*.test.ts                     # 新增约 20 用例
```
