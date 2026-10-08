# functions.md — 数据取数与落库六类通路详解

> 样本场景：Adjust 数据源（`data_source_adjust` → `https://automate.adjust.com/reports-service`）与物理表 `data.adjust_daily_metrics`（5 维主键 + 16 指标）。
> 六类通路 = 3 种行为 × 2 条方向：读上游 API / 读本地表 SQL / 写本地表。
> 本文与代码同步基线：2026-09-29；如与源码有出入，以源码为准。

---

## 0. 总览

| # | 通路 | 方向 | 数据来源/去向 | 一句话机制 | 是否受"同步重置语义模型"影响 |
|---|---|---|---|---|---|
| 1 | aggregate / filter（算子直查） | 读 | 上游 `/report` 实时 | 按语义模型的 `apiSlug` 拼全维度请求，缓存兜底 | 是（新字段下次同步后消失） |
| 2 | query_api_source（自由探索工具） | 读 | 上游任意终端 | LLM 任意 path/params，预算受限 | 否（完全不依赖语义模型） |
| 3 | timeseries / anomaly（算子） | 读 | 本地表 SQL | 目录 + 表列名全部来自语义模型 | 是 |
| 4 | semantic/translate（试运行） | 读 | 本地表 SQL | SemanticQuery 结构化查询编译为 SQL | 是 |
| 5 | adjust-sync（固定常量） | 写 | 上游 `/csv_report` → 本地表 | 代码常量读写固定 5 维 16 指标；**每跑一次重置语义模型** | 它就是重置者 |
| 6 | api-ingest（按模型） | 写 | 上游 `/report` 响应 → 本地表 | 被通路 1 隐式触发，按模型建表/落库 | 是（随模型走） |

**共同底座**

- **语义模型**（`cause.semantic_models`）：指标/维度定义 + `apiSlug`（本地列 ↔ 上游 slug 双向映射）+ 数据源路由（`dataSourceId` 为空走本地 SQL，非空走 API 直查）。
- **查询缓存**（`cause.api_query_cache`）：key = method + endpoint + path + params（与参数顺序无关）；TTL 按区间新鲜度推断（today/近 2 日 30 分钟、结束日 ≥2 天前 7 天、缺省 1 小时）；429/5xx 与网络异常指数退避重试（优先 `Retry-After`）；同源最小调用间隔 200ms。
- **物理表** `data.adjust_daily_metrics`：5 维主键（stat_date, network, country_code, os_name, campaign_network）+ 16 指标列，由同步链路常量固化。

---

## 1. 走上游 API — aggregate / filter（算子直查）

**作用**

- 让 Agent / 用户用「语义指标 key + 维度 id」直接取 Adjust 最新数据，无需知道上游 slug、path、鉴权。
- `aggregate`：单指标 × 单维度分组聚合（支持维度值过滤、时间范围），是 LLM 问答的主取数动作。
- `filter`：按模型全维度 + 全指标下钻明细，用于验证与明细展开。

**现在实现的效果**（`lib/server/operators/data-operators.ts`）

- 分流依据：`resolveApiSource(entry.dataSourceId)` 非空 → API 直查；为空 → 本地 SQL。Adjust 模型挂 API 源，永远走直查，**不读本地表**。
- `aggregate` 两段式：
  1. **扩维请求**：模型全维度 slug + 该指标 slug（响应体上限放宽到 8MB），成功且未截断 → 内存聚合（`aggregateRowsInMemory`，含维度值过滤）→ 返回结果并顺带触发落库（通路 6）；
  2. **回退**：上游拒绝维度组合或响应截断 → 单维度直查（不带 model 参数，不落库）。
- `filter`：模型全维度 + 时间维度 + 全部可聚合指标（8MB）→ 响应 slug 映射回本地 id → 内存按 filters 过滤。
- 请求形如 `GET /report?dimensions=...&metrics=...&date_period=...&utc_offset=+08:00(&sort=-指标)`；JSON 终端额外返回 `totals`（区间总量校验）与 `data_warnings`，写入结果 notes。
- 缓存：先查本地缓存——fresh 命中不请求上游；上游异常降级 stale；miss 才直查并回写缓存。

**如何触发**

- Agent 问答/研究流程（`POST /api/v1/ask` 驱动的 DataAnalystWorker 等，`lib/server/agents/workers.ts`）由 LLM 调用 `run_operator` 工具；算子清单与指标/维度目录**运行时**由语义层动态生成，LLM 无法指定 sourceId / path / 上游 slug。
- 算子试运行 UI / 直连 API：`GET /api/v1/operators`（注册表）→ `POST /api/v1/operators`（执行；源码注释写作 `/operators/run`，实际路由为 `/api/v1/operators`）。

**与算子的关系与影响**

- 语义层注册决定可用范围：指标必须在目录内、`groupBy` 必须是**该指标所属模型**的维度（时间列除外）。
- 在语义模型新增指标/维度后，本通路**立即可用**（请求自动携带新 slug）——但受通路 5 的"模型重置"与上游权限门控（revenue/ecpm 类指标被拒）约束。
- **不受物理表结构影响**：表缺列、PK 不符都不影响本通路取数。
- 与其他通路联动：miss 响应顺带落库（通路 6）；与 `query_api_source` 共用同一份查询缓存。

---

## 2. 走上游 API — query_api_source（自由探索工具）

**作用**

- 给 Agent 一个绕过语义层的自由探索入口：任意 REST `path`/`method`/`params`/`body`，或 GraphQL `query`/`variables`（禁止 mutation），CSV 响应自动结构化为表格。
- 定位：**仅用于语义层未建模的数据探索**；已建模指标要求优先走 `run_operator`（工具描述中明确写了这一分工）。

**现在实现的效果**（`lib/server/agents/tools.ts` + `lib/server/connectors/`）

- 单任务预算 **6 次**调用，超出直接拒绝并提示基于已有数据作答。
- 响应体默认 200KB 截断（未截断的大响应仍回写缓存）；返回给 LLM 前再截断到 20,000 字符。
- 经查询缓存与 200ms 限流；**不落库**（不传 model，不触发通路 6）。
- 与通路 1 共享缓存键：同一 `method + endpoint + path + params` 的探索结果，后续算子请求可命中 fresh。

**如何触发**

- Agent 自主调用（仅当任务注册了外部 API 数据源时才挂载该工具）。无 UI 入口、无 HTTP 路由。

**与算子的关系与影响**

- 与算子目录、语义模型、物理表**完全解耦**：加了字段不会被它感知，改表也影响不到它。
- 不产生"副作用数据"（不落库、不进趋势），探索结论要固化必须走语义模型注册（再被通路 1/3/4 消费）。
- 预算与截断是硬约束：大区间明细探索容易截断，明细完整取数应交给通路 1 的扩维路径（8MB）。

---

## 3. 走本地表 SQL — timeseries / anomaly（算子）

**作用**

- `timeseries`：任意指标按日/周/月聚合的时序分析，自动计算环比（LAG 1 期）与同比（日 365 / 周 52 / 月 12 期）。
- `anomaly`：基于 28 日滚动窗口 Z-Score 检测异常日（阈值 1–5，默认 2）。

**现在实现的效果**（`lib/server/operators/data-operators.ts`）

- **纯本地 SQL，无 API 分支**：`FROM ${model.schema}.${model.table}`（Adjust 模型即 `data.adjust_daily_metrics`），经只读连接 `executeReadOnlyQuery(DATABASE_URL)` 执行。
- 结果上限：timeseries 800 行、anomaly 50 行；执行前校验 `supportsTime`（模型 timeColumn 非 "id"）。
- 数据来源 = 物理表里的全部数据（通路 5 每日同步 + 通路 6 按需落库的并集），**与上游实时性无关**。

**如何触发**

- 与通路 1 相同：`run_operator` 工具（LLM）或 `POST /api/v1/operators`（试运行）。

**与算子的关系与影响**

- 与表结构强耦合：**语义模型加指标但表未加列 → 显式报错** `column "xxx" does not exist`（failed 结果携带生成的 SQL）；加维度则不受影响（这两个算子的 SQL 不引用维度列）。
- 时效不自洽风险：同步覆盖不到的历史/明细区间，只有通路 6 落过库才可查；`--reset` 期间表被 DROP 重建，存在短暂空窗。
- 与通路 1 的区别：同一指标，aggregate 取的是**上游实时**数据，timeseries/anomaly 取的是**本地已落库**数据，两者可能不一致（如同步滞后、ingest 未触发）。

---

## 4. 走本地表 SQL — semantic/translate（语义查询试运行）

**作用**

- 结构化语义查询（`SemanticQueryV1`：指标/维度/时间范围/粒度/排序）→ 自动选择最优模型（指标命中权重 2、维度命中权重 1 打分）→ 编译为 PostgreSQL SQL → 只读执行，返回 SQL + 结果集，"配置即验"。

**现在实现的效果**（`app/api/v1/semantic/translate/route.ts` + `lib/server/semantic/semantic-query.ts`）

- SQL 按标准子句顺序（WHERE → GROUP BY → ORDER BY → LIMIT）拼接；时间粒度映射 date_trunc / to_char。
- 执行目标：模型数据源的连接串；内置/无法解析时回退 `DATABASE_URL`。Adjust 模型的实际执行落点是本地 PG 库。
- `agg="none"` 的派生指标不做公式执行（仅裸选列）——比率类公式登记在 `cause.metrics.formula`，仅作口径参考。

**如何触发**

- 语义层管理页「试运行」入口（`app/(dashboard)/semantic/client.tsx` → `POST /api/v1/semantic/translate`）；无 Agent 工具接线。

**与算子的关系与影响**

- 与表结构强耦合：编译出的 SQL 只要引用到不存在的列（新加指标/维度未迁移表），执行即报错；这与通路 1 的"表无关"形成对照。
- 模型被通路 5 重置后，新字段从模型目录消失，本入口同步恢复原状。
- 与算子共享同一套语义模型定义，但**取数不走算子层**（无缓存、无 API 直查、无落库副作用）。

---

## 5. 写本地表 — adjust-sync（固定常量）

**作用**

- Adjust T+1 数据的每日同步：按天分块拉取 `/csv_report` 落库，并维护语义模型与指标口径（幂等，可安全重跑）。
- 是该表**常规全量数据**的唯一来源（5 维粒度 16 指标）。

**现在实现的效果**（`lib/server/integrations/adjust-sync.ts`）

- 六步流程：① `/events` 事件 slug 校验（仅预警）→ ② 建表（`CREATE TABLE IF NOT EXISTS`，5 维 PK + 16 指标 + 日期/渠道索引；`--reset` 时先 DROP）→ ③ 按天分块拉 `/csv_report`（单日 ~8.6k 行/24s，超时 90s，429/5xx/网络异常最多 3 次退避重试，204 跳过，单日失败不阻断整批）→ ④ **重挂语义模型**：`DELETE` + 重插 `semantic_model_adjust_daily`（写死 16 指标/5 维/`apiSlug` 映射）→ ⑤ 补录 `cause.metrics` 口径定义（7 个基指标 + 6 个派生率 formula）→ ⑥ 汇总验证输出。
- 写库细节：`INSERT` 固定 21 列 + `synced_at`；冲突目标固定 5 维；批量 400 行/批。
- 回补窗口：相对 `--days N`（默认 3，覆盖 T+1 修正窗口）或绝对 `--from/--to`（补任意历史中段）；两者都可叠加 `--reset` 清空重建。

**如何触发**

- CLI：`npx tsx scripts/sync-adjust-data.ts [--days N | --from … --to …] [--reset]`。
- 服务内 API：`POST /api/v1/syncs/adjust`（项目无常驻定时器，由外部 cron 每日调用，如 `30 9 * * *`，`days=3`）。
- 前置条件：`ADJUST_API_TOKEN`（缺失 503）、`ADJUST_RS_API_BASE_URL`、`ADJUST_RS_UTC_OFFSET`（缺省 +08:00）。

**与算子的关系与影响**

- 数据供给：通路 3/4（读表算子）的数据全量来源；通路 1 不依赖它（直查上游）。
- **最大副作用——语义模型重置**：第 ④ 步先删后插写死定义，语义层任何手工扩指标/扩维度的"寿命"只到下一次同步为止。想让扩展持久，必须改本文件的常量与挂载定义（或另建独立模型）。
- 与表结构变更的兼容边界：
  - `ALTER` 加**指标列**（NUMERIC NOT NULL DEFAULT 0）：同步不受影响（只写自己固定的 21 列）；
  - `ALTER` 加**维度列/改 PK**：同步的 `ON CONFLICT (5 列)` 推断不到匹配唯一索引（PG 要求精确匹配）→ 每块 upsert 报错、全量失败；新维列 NOT NULL 无默认值时还会在 INSERT 处先触发 not-null 违约。
  - `--reset` 会 DROP 表重建：通路 6 落库的数据、任何手工迁移的列一并丢失（按固定 DDL 重建）。
- 上游约束会原样进入本地表：该账号 revenue/ROAS/eCPI 类指标被权限门控，`network_cost` 恒为 0（保留列对齐官方三口径）。

---

## 6. 写本地表 — api-ingest（按模型）

**作用**

- 把通路 1 的**真实上游响应**（cache miss、未截断）按语义模型"分解落库"，让本地表在同步覆盖范围之外也能积累明细（供通路 3 复用）。

**现在实现的效果**（`lib/server/integrations/api-ingest.ts`）

- 触发条件（唯一入口在 `fetchApiReportRows` 内）：传入了 model 且 `cacheState === "miss"` 且响应未截断且行数 > 0 且 `shouldPersist`（**请求维度覆盖模型全部维度**）——缓存命中不触发。
- 建表：`CREATE TABLE IF NOT EXISTS`（模型全维度列 + 模型全部可聚合指标列 NOT NULL DEFAULT 0 + `synced_at`，PK = 模型全维度）；**只建不改，不会 ALTER 已有表**。
- 写入：`INSERT ... ON CONFLICT (模型全维度) DO UPDATE`，**只更新本次响应实际出现的指标列**（部分指标请求不会把未请求列清零）；批量 400 行/批；单次上限 50,000 行（超限跳过）；主键值缺失的行丢弃。
- 失败策略：任何异常（缺列、冲突目标不匹配、超限等）仅 `console.warn` 并返回 0，**不影响本次取数结果**。

**如何触发**

- 无独立入口，被通路 1 隐式触发：
  - `aggregate` 扩维路径（全维度 + 单指标）；
  - `filter` 路径（全维度 + 时间维度 + 全指标）。
- 回退的单维度直查不带 model 参数，不落库。

**与算子的关系与影响**

- 是通路 3 的"增量数据源"：读者（aggregate/filter）顺带产出供另一个读者类算子（timeseries/anomaly）使用。
- 语义层加字段后本通路**静默失败**（表缺列 / 冲突目标与 PK 不匹配），这正是"改了语义层却发现什么也没发生"的原因；但也保证它永远不会把取数打挂。
- 与通路 5 共用同一张表：同步负责全量常规数据，ingest 负责补漏；两者的冲突目标必须都命中表上的唯一约束才成立（当前 5 维 PK 同时满足两者，前提是模型维度未被改动）。

---

## 7. 跨通路推演：给语义模型"加字段"到底会发生什么

以"在语义层给 `semantic_model_adjust_daily` 加一个指标/维度"为中心的推演矩阵（表未做任何迁移）：

| 动作 | ①aggregate/filter | ②query_api_source | ③timeseries/anomaly | ④translate | ⑤sync | ⑥ingest |
|---|---|---|---|---|---|---|
| 语义层加**指标**（表无列） | ✅ 正常出数（直查 API） | 无感 | ❌ 显式报错（列不存在） | ❌ SQL 报错 | 不受影响；下次运行**重置模型** | ⚠️ 静默失败（缺列，仅告警） |
| 语义层加**维度**（表无列） | ✅ 正常（groupBy 可用；上游组合被拒则回退） | 无感 | ✅ 不受影响（SQL 不引用维度列） | ❌ SQL 引用到该维度才报错 | 同上，**重置模型** | ⚠️ 静默失败（缺列 + 冲突目标不匹配） |
| 手工 `ALTER` 加**指标列**（NOT NULL DEFAULT 0） | ✅ | 无感 | ❌ 旧模型无该指标前仍报"未知指标"；模型补上后 ✅ | 模型补上后 ✅ | 不受影响（只写固定 21 列）；仍会重置模型 | ✅ 落库恢复 |
| 手工 `ALTER` 加**维度列/改 PK** | ✅（模型补维度后） | 无感 | 不适用 | 不适用 | ❌ **同步的 ON CONFLICT(5 列) 被打断，全量分块失败** | ❌ 需 6 维唯一索引才能落库，与 5 维 PK 互斥 |
| 触发一次每日同步 | 模型被重置后新字段失效（"未知指标/无维度"） | 无感 | 恢复原 16 指标 | 恢复原样 | — | 恢复原样 |

**生命周期结论**

1. 只改语义层 → 修改会被下一次同步（通路 5）静默删除；期间仅通路 1 能用到新字段，通路 3/4 报错、通路 6 静默失败。
2. 想让扩展持久且全通路一致，唯一正解是**同步升级代码**：改 `adjust-sync.ts` 的指标/维度常量、DDL、冲突目标与第 ④ 步挂载定义，再配套迁移物理表并回补（`--reset` 或区间回补）。
3. 不想动同步链路又想落库 → 另建一个独立模型（不同 model id / 不同表，如 raw SQL 挂载 API 源），通路 6 会在首次全维度响应时自动建表并落库；注意当前语义模型 API 只接受 `bi` 类型数据源，挂 `api` 源需要 raw SQL 或小改代码。

---

## 附：相关旁路与不在六类中的算子

- `sql_query`（Agent 工具）：LLM 自由手写只读 SQL（SELECT/WITH），可直查 `adjust_daily_metrics` 本地列；不受语义模型驱动，缺列同样报 SQL 错误。它属于"读本地表"家族，但不是模型化通路。
- `inspect_schema` / `show_table` / `generate_chart`：schema 查看、表格展示、图表生成，不取数。
- `transform` / `join` 数据算子：绑定渠道模型（`semantic_model_channel_daily` / `semantic_model_channel_campaigns`，本地 PG 表），与本文 Adjust 六类通路无直接耦合。
- MCP 数据源（`query_mcp_source`）：子 ReAct Agent 方式调用，预算 3 次/任务，不在六类之中。



摸清了。当前"任务问答"的路径选择是**两级 LLM 决策**：第一级 Supervisor 决定要不要走数据分析，第二级 DataAnalystWorker 在工具集里选具体取数路径。而你列的四条路里，**第 4 条（translate）根本不在大模型的决策空间里**——它没有挂成 Agent 工具，只有语义层 UI 的"试运行"入口。实际参与决策的是三条 + `sql_query` 兜底。

## 一、决策链路全貌

```
用户问题
 └─ ① Supervisor 路由（LLM，temperature=0，只输出 JSON）
    prompts.ts ROUTING_PROMPT：涉及内部投放指标 → data_analysis；
    涉及外部行业情报 → research；纯知识 → direct；两者兼有优先 data_analysis
    └─ data_analysis → ② DataAnalystWorker（ReAct，temperature=0，recursion 50）
       ├─ 注入：数据字典（每张表 + 本地数据范围 + API 血缘）
       ├─ 注入：算子目录（指标/维度/6 算子，运行时由语义层动态生成）
       └─ LLM 逐轮从工具集中选择：
          run_operator / sql_query / inspect_schema / show_table / generate_chart
          + query_api_source（仅当注册了 api 类型数据源时才挂载）
```

工具装配在 [workers.ts](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/workers.ts#L58-L85)，四级路由规则在 [ROUTING_PROMPT](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/prompts.ts#L30-L47)。

## 二、四条路（+sql_query）的决策规则

| 路径 | LLM 何时选它 | 规则载体 |
|---|---|---|
| **1. aggregate/filter** | **默认主力**：标准分析动作强制优先。"分组聚合/排名/占比→aggregate；下钻过滤→filter"；**目标日期超出本地范围 → 必须用 aggregate/filter**（自动直连 API） | [prompt 规范 1/8](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/prompts.ts#L97-L109) + [run_operator 工具描述](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/tools.ts#L36-L50) |
| **2. query_api_source** | **逃生舱**，有严格准入："已建模的报告类指标/维度取数应优先用 run_operator，本工具**仅用于语义层未建模的自由 API 探索**"；预算 6 次/任务 | [工具描述](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/tools.ts#L536-L548) + [external block](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/prompts.ts#L116-L122) |
| **3. timeseries/anomaly** | 标准动作映射："趋势/同比/环比→timeseries；异常检测→anomaly；问'为什么'时先用 anomaly 定位再下钻" | prompt 规范 1/6（同上） |
| **4. translate** | **LLM 不可达**——没有 Agent 工具接线，只有语义层管理页「试运行」 | workers.ts 工具集 |
| （sql_query） | **兜底**："仅当算子无法表达（多表自由关联、特殊口径统计）时才用"；不熟悉列名必须先 inspect_schema | prompt 规范 1/2 + [工具描述](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/tools.ts#L165-L171) |

## 三、最关键的机制：API vs 本地表不由 LLM 决定

这是最容易误解的点——**LLM 只选"算子类型"，不选"数据源"**：

- 工具描述明确写了："数据源路由（本地 PG 库 / 外部 API 源的本地缓存+API 直查）由算子依据**指标所属数据源**自动决定，**你无需也不能指定 sourceId、path 或上游 slug**"。
- 所以同一个 Adjust 指标：LLM 调 aggregate/filter → 自动走 API 直查（通路 1）；LLM 调 timeseries/anomaly → 自动走本地表 SQL（通路 3）。**算子的选择顺带决定了数据源的实时 vs 快照属性**。
- prompt 还要求 LLM 交叉验证时"说明口径"——正是因为这两条路结果可能不一致。

## 四、新鲜度机制：引导 LLM 改变路径选择

数据字典（[runtimeTablesHint](file:///Users/roryyu/Downloads/code/qoder-app/pt-ai-acquisition-cause/lib/server/agents/tools.ts#L644-L671)）给每张表注入了**本地数据范围（MIN~MAX + 行数）或"⚠️ 本地暂无数据"** + API 血缘标注。prompt 规范 8 要求 LLM 回答任何带日期的问题前先核对：

- 目标日期**在本地范围内** → 算子/SQL 查本地即可（LLM 自由选 aggregate/timeseries/sql_query）；
- 目标日期**超出本地范围**（"今天/昨天/最新/N 号"）→ **禁止**用陈旧/空的本地数据，**必须**用 aggregate/filter 指定语义指标 key 直连 API 取回。

## 五、规则组合下的两个缝隙（客观存在）

1. **"最近按天趋势"没有完美算子路径**：aggregate 的 groupBy 不允许时间列（`operatorDimensionsForModel` 排除 timeColumn），而 timeseries 没有 API 分支。当本地快照未覆盖目标日期时，规则上"超范围必须 aggregate/filter"与"趋势用 timeseries"无法同时满足——LLM 的实际兜底只能是 query_api_source 手写 `dimensions=day`，或 `filter` 拉含日期的明细自行聚合（受截断/行数限制）。这一情形 prompt 层面没有明确指令，属于模型自行判断的空间。
2. **缓存改变的是副作用而非选择**：通路 1 miss 时才触发落库（通路 6）；LLM 无法感知缓存，但反复查询同一区间会"第一次 miss 落库、后续 fresh 命中"，并且 query_api_source 与算子共享缓存——探索过的区间，后续算子调用可以直接命中。

## 一句话总结

LLM 的决策逻辑是：**"先按分析动作选算子（分组→aggregate、趋势→timeseries、异常→anomaly、下钻→filter），再按数据新鲜度决定是否必须走 aggregate/filter 直连 API，算子无法表达才用 sql_query，语义层未建模才用 query_api_source"**——API/本地表的分流、缓存、落库全部发生在算子内部，对 LLM 是黑盒。translate 只是人工试运行工具，不参与问答链路。
