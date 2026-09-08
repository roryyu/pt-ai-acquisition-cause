# Adjust RS API 指标/维度对齐：优化计划与实现

> 日期：2026-09-08
> 触发：比对官方《Datascape metrics glossary》后，发现 API 取数与 `data.adjust_daily_metrics` 落表存在明显缺失
> 关联：术语表全文见 [`doc/api-metrics-glossary.md`](./api-metrics-glossary.md)；三表实体复审见 [`doc/data-review-again.md`](./data-review-again.md)
> 验证方式：用本账号 Token 直连 RS API（`/report` JSON 终端）逐族探活，以真实响应为准，不臆造 slug

---

## 一、官方文档解读（摘要）

Adjust Report Service API 指标分 9 大族：

| 族 | 代表指标（API slug） | 口径要点 |
|---|---|---|
| 转化 Conversion | `impressions/clicks/installs/sessions/base_sessions`、`organic_installs/non_organic_installs`、`reattributions`、`daus` | 日粒度可加 |
| 同期群 Cohort | `retention_rate_dN`、`lifetime_value_*`、`roas_*` | **按安装群组**，非日活口径，率类不可加 |
| 广告花费 Ad Spend | `cost`(总)、`adjust_cost`(归因)、`network_cost`(渠道 API) | **三口径并存**，数值可能不同 |
| 收入 Revenue | `revenue/all_revenue/ad_revenue/roas/gross_profit` | 需收入权限 |
| SKAN / 订阅 / 助攻 / InSight | `skad_*`、`subscrevnt_*`、`assisted_installs` | 多为专项方案 |
| 反欺诈 Fraud | `rejected_installs`、`rejected_install_rate` | 监控假量 |

维度支持 `day/network/country_code/os_name/campaign_network` 等。

---

## 二、活体 API 探活证据（本账号实测，2026-09-06 单日）

在 **5 维粒度**（`day,network,country_code,os_name,campaign_network`）+ 16 指标一次请求：

- **HTTP 200，8,624 行，24.3s**
- **非 0 指标（15 个，真实有数）**：
  `impressions` 2941万 · `clicks` 6036万 · `installs` 57.7万 · `sessions` 880万 · `base_sessions` 820万 ·
  `organic_installs` 7.8万 · `non_organic_installs` 49.9万 · `reattributions` 3.06万 ·
  `register_events` 4.3万 · `firstdeposit_events` 2.6万 · `recalldeposit_events` 1.6万 ·
  `daus` 407万 · `rejected_installs` 4342 · `cost` 7.7 · `adjust_cost` 7.7
- **恒 0 指标**：`network_cost`（该账号未对接渠道成本 API）
- **权限门控（HTTP 400，无法接入）**：`revenue/all_revenue/roas/gross_profit`（`loc=revenue`）、`ecpi/ecpm/ecpc/paid_*`（`loc=ecpm`）
- **比率 slug 可用性**：`ctr`、`click_conversion_rate`、`impression_conversion_rate`、`rejected_install_rate`、`ecpi_all`、`retention_rate_d1` 均 200（格式为 `_dN`；`retention_rate_1d/_7d/_0d` 均 400）
- **时序（决定分块策略）**：单日 24.3s（逼近旧超时 30s）；**3 日 37.8s > 30s 必超时** → 分块必须 = 1 天/请求，且超时需上调

---

## 三、当前实现 vs 官方：缺口

| 维度 | 现状（adjust-sync 硬编码） | 缺口 |
|---|---|---|
| 粒度 | `day×network×country_code`（3 维） | 缺 `os_name`、`campaign_network` |
| 成本 | 仅 `network_cost`（**恒 0**） | 未取有真实数据的 `cost`/`adjust_cost` → **成本盲区** |
| 漏斗 | `impressions/clicks/installs/sessions` | 缺 `base_sessions`、`organic/non_organic_installs`、`reattributions` |
| 活跃/欺诈 | 无 | 缺 `daus`、`rejected_installs` |
| 事件 | `register/firstdeposit/recalldeposit_events` | ✅ 已有 |
| 落库真实性 | 表内 19,994 行 | **多数指标列停留默认 0** —— 全列同步从未真正跑过 |

---

## 四、根因

1. **成本用错指标**：同步一直请求恒 0 的 `network_cost`，而账号实际有数的是 `cost`/`adjust_cost`。
2. **全列同步未真正执行**：`adjust_daily_metrics` 现有数据是 `api-ingest` 单指标扩维查询零散写入的（只更新当次请求的指标列），`adjust-sync` 的全列 upsert 从未成功跑过 → `impressions/clicks/sessions` 等大面积为 0。
3. **粒度不足**：无 OS / 计划维度，无法做端侧与计划级归因分析。

---

## 五、优化方案

### 5.1 新表结构（5 维主键 + 16 可加指标）

主键（维度）：`stat_date`(←`day`)、`network`、`country_code`、`os_name`(新)、`campaign_network`(新)

指标（全部 `agg=sum`，可加、SUM 安全）：

| 列 | 类型 | ← API slug | 说明 |
|---|---|---|---|
| impressions/clicks/installs/sessions | BIGINT | 同名 | 展示/点击/安装/会话 |
| base_sessions | BIGINT | `base_sessions` | 基础会话（不含安装/再归因） |
| organic_installs/non_organic_installs | BIGINT | 同名 | 自然/付费安装拆分 |
| reattributions | BIGINT | `reattributions` | 再归因 |
| register_cnt/first_deposit_cnt/recall_deposit_cnt | BIGINT | `register_events`/`firstdeposit_events`/`recalldeposit_events` | 自定义事件 |
| daus | BIGINT | `daus` | 日活（跨日汇总为人日累加口径） |
| rejected_installs | BIGINT | `rejected_installs` | 反欺诈拒绝安装 |
| cost/adjust_cost | NUMERIC(18,4) | 同名 | 广告花费（总/归因口径，**有真实数据**） |
| network_cost | NUMERIC(18,4) | `network_cost` | 渠道口径花费（当前恒 0，保留对齐官方三口径，接入后自动有数） |

### 5.2 派生率：走 `cause.metrics` 目录，不落物理列

- **依据**：全仓无任何代码执行 `cause.metrics.formula`（仅 adjust-sync INSERT）；语义模型 `agg="none"` 的指标会被 operator 目录跳过、被 api-ingest 跳过、`translateToSql` 只裸选列（无公式执行）→ 把率塞进语义模型会变**死列/误导聚合**。
- **做法**：`ctr/ccr/icr/ecpi(=cost÷installs)/rejected_install_rate/fd_rate` 以 formula 文本登记进 `cause.metrics`（沿用既有 `metric_adjust_fd_rate` 模式），供 LLM/目录知晓口径；实际比率经**多指标语义查询**从已落库的基列（clicks、impressions、installs、cost、rejected_installs…）计算。
- **同期群留存**（`retention_rate_dN`）：cohort 日期语义与日活表冲突且非可加，**排除**出本表，留作后续独立 cohort 表。

### 5.3 分块同步（修根因 2 + 超时）

- 按天分块：窗口 `-Nd:-1d` 拆成 N 个 `-id:-id` 单日请求（沿用 Adjust 相对日期，交给上游处理时区）。
- 超时 `REQUEST_TIMEOUT_MS` 30s → **90s**（单日实测 24s，留足余量）。
- 单日失败（重试后仍失败）→ 记 warning 并继续，不中断整批回补；末尾汇总失败日。

### 5.4 清空重同步（PK 3→5 维，旧表必须重建）

- 新增 `reset` 选项 + CLI `--reset`：`DROP TABLE IF EXISTS` 后按新 5 维 DDL 重建，再全量回补。
- 日常增量（`reset=false`）：对已存在的 5 维表做幂等 upsert。

---

## 六、实现清单

| 文件 | 改动 |
|---|---|
| `lib/server/integrations/adjust-sync.ts` | 16 指标 slug、5 维 `buildSyncReportParams`、按天分块主流程、超时 90s、`reset` 清库重建、5 维 DDL + upsert、语义模型（16 指标/5 维）、`cause.metrics` 派生率目录、纯函数 `buildDayChunks` |
| `scripts/sync-adjust-data.ts` | 新增 `--reset` 解析并透传 |
| `tests/adjust-sync.test.ts` | 更新维度/指标断言；新增 `buildDayChunks` 分块测试 |
| `lib/server/integrations/api-ingest.ts` | **无需改**（模型驱动，自动派生 5 维表结构） |
| `lib/server/operators/data-operators.ts` | **无需改**（模型驱动，扩维请求自动用 5 slug） |

---

## 七、验证（已完成）

- **类型检查**：`npx tsc --noEmit` → 0 error
- **单测**：`npx vitest run tests/adjust-sync.test.ts tests/api-ingest.test.ts tests/operators.test.ts` → **57 passed**（含新增 `buildDayChunks` 分块、16 指标集断言）
- **eslint**：4 个改动文件 exit 0
- **活体重同步**（`--reset --days 3` → `--days 3`）：3 天全部成功、26,469 行；过程中发现并修复网络层瞬时 `fetch failed`（`rsFetch` 增加网络异常指数退避重试，`MAX_RETRIES` 2→3，错误信息带 undici `cause`）
- **库内核验**（直连 PG `information_schema` + 聚合）：
  - 表结构 22 列 = 5 维主键 + 16 指标（13 BIGINT + 3 NUMERIC）+ `synced_at` ✅
  - 新列非零覆盖：`base_sessions` 17011 · `daus` 16951 · `non_organic_installs` 1725 · `reattributions` 918 · `rejected_installs` 590 · `organic_installs` 145 · `cost`/`adjust_cost` 各 3（花费稀疏但真实，全在 iOS DSP 计划）· `network_cost` 0（恒 0，符合预期）
  - 新维度：`os_name` 11 种（android 140 万安装 / ios 18 万含全部花费 / windows 12.7 万…）、`campaign_network` 4820、`network` 167、`country_code` 224
  - **成本盲区已修复**：`cost`/`adjust_cost` 有真实非零花费（3 天 $24.20），不再是全 0 的 `network_cost`
- **全量回补**：`npx tsx scripts/sync-adjust-data.ts --days 100`（2026-05-31→09-07）后台执行中，约 40min，失败日单独记 warning 可重跑

---

## 八、后续（本次未做，需决策/申请）

1. **收入侧**：`revenue/all_revenue/roas/gross_profit`、`ecpi/ecpm` 权限门控 → 需向 Adjust 申请收入权限后方可接入 ROAS/LTV 分析。
2. **同期群表**：新建 `adjust_cohort_metrics`（按安装日 × 群组周期）承载 `retention_rate_dN`/`lifetime_value_*`，与日活表分离。
3. **派生率执行引擎**：为语义模型 `agg="none"` 增加 formula 执行（`SUM(a)/NULLIF(SUM(b),0)`），使 ctr/ecpi 成为一等可查指标。
4. **同步并发**：回补可引入有限并发（Adjust 允许 50 req/s），将 40min 压缩至 ~10min。
