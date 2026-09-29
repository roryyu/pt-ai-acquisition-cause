# deploy-update.md — Access 凭据接入与 .env 更新手册

> 使用时机：deploy.md 步骤 1–7 已完成（容器 healthy、`/api/health` 通），且已从 Access 管理员处拿到生产凭据。
> 目标：把服务器 `.env` 里的本地默认值/占位值换成生产值，让 OIDC 登录链路真正可用。
> 本手册是 deploy.md **步骤 9 的展开版**；环境变量为运行时注入，**改 .env 不需要重新 build 镜像、不需要重跑迁移**（auth 相关表已在基线迁移 `0_init` 中）。

---

## 1. 向 Access 管理员要什么

### 1.1 直接要的 4 项（对应 .env 变量，缺一登录不可用）

| # | .env 变量 | 向管理员要什么 | 值的形态 | 默认值为什么不能用 |
| --- | --- | --- | --- | --- |
| 1 | `OIDC_ISSUER` | 生产 pt-ai realm（Keycloak）的签发者地址 | `https://<identity域名>/realms/pt-ai` | 默认 `http://localhost:8094/realms/pt-ai` 指向本地模拟器 |
| 2 | `OIDC_CLIENT_SECRET` | client `pt-ai-cause` 的生产 secret | 随机字符串 | 默认 `pt-ai-cause-oidc-local-only` 是本地占位值 |
| 3 | `ACCESS_INTERNAL_BASE_URL` | access-app 的 `/internal/*` 接口基址（**纯服务端调用，见下方「网络可达性对照」注；不是线上 Access 前端管理台的那个域名**） | `http://<内网IP>:4300`（内网直连优先） | 默认 `http://localhost:4300` 指向本地容器 |
| 4 | `ACCESS_INTERNAL_SECRET` | internal 共享密钥（请求头 `x-pt-access-internal-secret`） | 随机字符串 | 默认 `pt-ai-access-internal-local-only` 是本地占位值 |

另请管理员**顺口确认两个命名**（与代码默认一致就无需改 .env）：

- `OIDC_CLIENT_ID`：默认 `pt-ai-cause`（Keycloak client 注册名）
- `ACCESS_ENTRY_ID`：默认 `cause`（Access entryCatalog 入口 ID）

> **网络可达性对照（避免拿错地址）**：
> - `OIDC_ISSUER`（Keycloak realm）：**浏览器 + cause 服务器都要可达**——用户登录 302 跳转（浏览器）与服务端 discovery/JWKS/token 兑换共用同一 issuer 地址，所以它才是那个「带域名」的地址；
> - `ACCESS_INTERNAL_BASE_URL`：**只有 cause 服务器需要可达**——代码里唯一消费点是 `lib/server/auth/access-client.ts` 的服务端 fetch（`/internal/session-activated`、`/internal/principal`，带 `x-pt-access-internal-secret` 头）；cause 的浏览器端不引用任何 Access 地址（无 `NEXT_PUBLIC_*` 变量），**不是线上 Access 前端管理台的域名**。内网直连（`http://<内网IP>:4300`）优先；若线上 Access 域名的反向代理同样路由 `/internal/*` 且能通过 §2 预检 P3，用域名亦可。

### 1.2 反向提供给管理员的登记项（不给全，登录必然失败）

cause 这边要**主动交给管理员去 Keycloak / Access 登记**的信息（依据：登录回调 `redirect_uri = {APP_URL}/api/auth/callback`，登出走 `post_logout_redirect_uri = {APP_URL}/login`）：

| 登记项 | 应登记的值 | 登记位置 |
| --- | --- | --- |
| redirectUris | `https://cause.pmdevops.com/api/auth/callback`（建议直接登 `https://cause.pmdevops.com/*`） | Keycloak client `pt-ai-cause` |
| post.logout.redirect.uris | `https://cause.pmdevops.com/login` | 同上（client attributes） |
| webOrigins | `https://cause.pmdevops.com` | 同上 |
| entryCatalog 条目 | launchUrl = `https://cause.pmdevops.com/api/auth/login?returnTo=/`，entryId = `cause` | Access 生产 catalog（`catalog:apply` 流程） |
| 首批用户 entitlement | 首批使用人员名单 → 开通 `cause` 入口授权 | Access 管理台 |
| 网络连通 | 确认 10.163.141.20 → identity 与 access-app internal 端口的内网可达（安全组/ACL） | 平台侧 |

> 依据鉴权设计（doc/鉴权接入PT-AI-Access设计.md §8）：**生产接入顺序 = Access 侧先登记（realm client + catalog + 密钥）→ cause 侧换 env → 管理台开通首批用户 entitlement**。所以要配置前先确认管理员已完成 Access 侧登记。

### 1.3 可并行的其他申请（非 Access 线，同一次 .env 更新一起做掉）

| 变量 | 来源 |
| --- | --- |
| `MODEL_GATEWAY_BASE_URL` / `MODEL_GATEWAY_API_KEY` / `MODEL_GATEWAY_DEFAULT_MODEL`（启动必填，当前是占位值） | 模型网关管理员 |
| `ADJUST_API_TOKEN` | Adjust 控制面板 → 账户设置 → 个人档案（自助） |

---

## 2. 更新前预检（不改 .env，用管理员给的地址直接测）

先替换块首三个变量再整段执行；**只回贴 P1–P3 的输出**（你替换的那三行含密钥，不要回贴）。

```bash
OIDC_ISSUER="https://<identity域名>/realms/pt-ai"        # ← 替换为管理员给的真实值
ACCESS_INTERNAL_BASE_URL="http://<access内网地址>:4300"   # ← 替换
ACCESS_INTERNAL_SECRET="<internal共享密钥>"               # ← 替换

echo "== [P1] OIDC discovery（issuer / 授权端点 / token 端点）=="
curl -s -m 10 "$OIDC_ISSUER/.well-known/openid-configuration" | jq -r '.issuer, .authorization_endpoint, .token_endpoint'

echo "== [P2] JWKS 可达（输出密钥个数，应 ≥1）=="
curl -s -m 10 "$OIDC_ISSUER/protocol/openid-connect/certs" | jq -r '.keys | length'

echo "== [P3] Access internal 探测（假 subject；预期 HTTP 403 + JSON 错误体，说明网络与密钥都通）=="
curl -s -m 10 -w '\n--- HTTP %{http_code} ---\n' -X POST "$ACCESS_INTERNAL_BASE_URL/internal/principal" \
  -H 'content-type: application/json' \
  -H "x-pt-access-internal-secret: $ACCESS_INTERNAL_SECRET" \
  -d '{"subject":"00000000-0000-0000-0000-000000000000","entryId":"cause"}'

unset OIDC_ISSUER ACCESS_INTERNAL_BASE_URL ACCESS_INTERNAL_SECRET
```

预检结果解读：

| 输出 | 结论 |
| --- | --- |
| P1 打印三行真实端点 URL | 服务器 → identity 连通且 realm 正确 ✅ |
| P1 为空 / 超时 | 服务器到 identity 不通或 issuer 写错 ❌ → 找管理员核对地址与安全组 |
| P2 输出 ≥1 | JWKS 可达，token 验签依赖就绪 ✅ |
| P3 返回 HTTP 403，body 含 `account_not_provisioned` 之类错误码 | **这正是预期**（假 subject 本来就查不到人）：网络通 + 密钥对 ✅ |
| P3 返回 HTTP 401/403 且 body 是 unauthorized 类错误 | `ACCESS_INTERNAL_SECRET` 不对 ❌ → 核对密钥 |
| P3 超时 / 000 / 502 | 服务器到 access-app internal 不通 ❌ → 核对地址与安全组 |

**P1/P3 全绿后再进入第 3 节**；不绿就先把网络/密钥问题退回管理员，改 .env 也没用。

---

## 3. 更新服务器 .env

```bash
cd /srv/cause/app
cp -a .env .env.bak-$(date +%Y%m%d%H%M)   # 先备份，改坏可回滚
vim .env
```

vim 中要改的行（`.env` 模板见 deploy.md 步骤 2；`<...>` 尖括号去掉）：

| .env 中现状 | 改成 |
| --- | --- |
| `# OIDC_ISSUER=<生产 Keycloak realm 地址>` | `OIDC_ISSUER=<第 1 项真实值>`（去掉行首 `#`） |
| `# OIDC_CLIENT_SECRET=<生产客户端密钥>` | `OIDC_CLIENT_SECRET=<第 2 项>` |
| `# ACCESS_INTERNAL_BASE_URL=<生产 access-app 内部接口地址>` | `ACCESS_INTERNAL_BASE_URL=<第 3 项>` |
| `# ACCESS_INTERNAL_SECRET=<生产共享密钥>` | `ACCESS_INTERNAL_SECRET=<第 4 项>` |
| `MODEL_GATEWAY_BASE_URL=http://127.0.0.1:1`（及 API_KEY / DEFAULT_MODEL 两个占位） | 若模型网关凭据也到了：替换三个占位值 |
| `# ADJUST_API_TOKEN=<...>` | 若 token 也到了：取消注释填值 |
| `OIDC_CLIENT_ID` / `ACCESS_ENTRY_ID` | 不必写（默认 `pt-ai-cause` / `cause`，与管理员确认一致即可） |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `DATABASE_URL` | **绝对不动**——数据库已按当前口令初始化，改了 app 立刻连不上库 |

改完打码自检（这个输出可以回贴给我）：

```bash
cd /srv/cause/app
sed -E 's/^(OIDC_CLIENT_SECRET|ACCESS_INTERNAL_SECRET|MODEL_GATEWAY_API_KEY|ADJUST_API_TOKEN)=.+/\1=***(masked)/' .env \
  | grep -E '^(# )?(OIDC|ACCESS|MODEL_GATEWAY|ADJUST)'
```

预期：`OIDC_ISSUER` / `ACCESS_INTERNAL_BASE_URL` 显示真实地址；四个密钥行显示 `***(masked)` 且**无行首 `#`**。

---

## 4. 生效（重建 app 容器，无需 rebuild / 无需迁移）

compose 会对比 env 变化**只重建 app 容器**（postgres 的 env 没动，不受影响）；镜像里没有烙任何密钥，不需要 `build`。

```bash
cd /srv/cause/app
docker compose --profile app up -d

for i in $(seq 1 40); do
  st=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose --profile app ps -q app)")
  echo "[$i] app health: $st"
  [ "$st" = "healthy" ] && break
  sleep 3
done

docker compose --profile app ps
docker compose --profile app logs app --tail 20
```

预期：app 容器 `Recreated` → `Up (healthy)`；日志无「环境变量校验失败」（若报，日志会指明哪个变量格式非法，回 vim 修正后再 `up -d`）。

---

## 5. 验证链路（由浅入深）

### V1 存活（本地）

```bash
curl -s http://127.0.0.1:3100/api/health | jq .
```

预期：`{"ok": true}`。

### V2 登录跳转（本地，验证 OIDC 装配与服务器→identity 出站）

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' 'http://127.0.0.1:3100/api/auth/login?returnTo=/'
```

预期：`302 -> https://<identity>/protocol/openid-connect/auth?...client_id=pt-ai-cause...redirect_uri=https%3A%2F%2Fcause.pmdevops.com%2Fapi%2Fauth%2Fcallback...`
（302 目标是 identity 授权页 = issuer/client_id/回调地址三者装配正确）。
若是 `302 -> /login?error=...`：identity 不可达或 issuer 写错，`docker compose --profile app logs app --tail 50` 看具体错误。

### V3 浏览器完整登录（需 deploy.md 步骤 8 的 ALB 已接好）

1. 浏览器打开 `https://cause.pmdevops.com/` → 点「使用 PT AI 账号登录」
2. 跳到 Keycloak 生产登录页，输入已开通 cause entitlement 的账号（首登可能强制改密）
3. 回跳工作台，topbar 显示姓名
4. 会话确认：`curl -s -o /dev/null -w '%{http_code}\n' https://cause.pmdevops.com/api/auth/session`（不带 cookie 应为 401；浏览器登录态下页面正常即会话有效）

### V4 登出

topbar 菜单「登出」→ 跳 Keycloak 登出确认 → 回到 `https://cause.pmdevops.com/login`。

### V5 数据侧确认（服务器）

```bash
cd /srv/cause/app
docker compose --profile app exec postgres psql -U cause -d cause \
  -c "SELECT id, username, name, last_login_at FROM cause.users ORDER BY created_at DESC LIMIT 5;"
docker compose --profile app exec postgres psql -U cause -d cause \
  -c "SELECT action, resource, created_at FROM cause.audit_logs ORDER BY created_at DESC LIMIT 5;"
```

预期：`users` 出现你的 Access subject（Keycloak UUID）；`audit_logs` 有 `login` 记录（若走了登出，还有 `logout`）。

### V6（可选）反向验证 entitlement 拦截

用一个**未开通 cause entitlement** 的账号登录：预期被拒回登录页并展示「未开通/无权限」类文案（对应 `entry_entitlement_required`），而不是进入工作台。有这个账号就顺手验，没有可跳过。

---

## 6. 常见故障速查

| 现象 | 大概率原因 | 处理 |
| --- | --- | --- |
| V2 或登录页出现 `identity_unreachable` 类错误 | 服务器 → identity 不通 / `OIDC_ISSUER` 写错 | 重跑 §2 预检 P1；找管理员核对地址与安全组 |
| Keycloak 登录页报 `invalid_client` / 401 | `OIDC_CLIENT_SECRET` 不对 | 与管理员核对 secret；改 .env 后重跑 §4 |
| Keycloak 报 redirect_uri mismatch | §1.2 登记项没给全 | 让管理员补 redirectUris（含 `/api/auth/callback`） |
| 登录页 error=`account_not_provisioned` / `entry_entitlement_required` | 该账号未开通 cause 入口授权 | Access 管理台开通后重试 |
| 登录成功但业务 API 503 `access_unavailable`（fail-closed） | 服务器 → `ACCESS_INTERNAL_BASE_URL` 不通 | 重跑 §2 预检 P3；核对内网地址与安全组 |
| `up -d` 后 app 反复重启 | .env 某值格式非法（如 URL 缺协议） | 看日志指名的变量，vim 修正后重跑 §4 |
| 误改了 `POSTGRES_PASSWORD` 导致 app 连不上库 | 数据库口令初始化时已固化 | `cp .env.bak-<时间戳> .env` 恢复备份后重跑 §4 |

---

## 7. 与其他文档的关系

- 本文档 = deploy.md **步骤 9（Access 部分）的完整展开**；模型网关 / Adjust 的更新同法（同一份 .env，同一套 §3–§4 流程）
- 若同时要发新代码版本：先走 deploy.md §4.1（打包上传 → 解压 → build → migrate deploy → up -d），.env 的修改可以合并在同一次 vim 里完成
- 全部验证通过后，进入 **verify.md**（prepare → install → deploy → verify 四阶段的收尾验收）
