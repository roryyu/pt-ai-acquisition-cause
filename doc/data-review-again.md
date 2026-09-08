# data schema 三表数据实体导出 + 维度互补性复审

> 复审日期：2026-09-08（含当日 `adjust_daily_metrics` 结构升级后的复核）
> 数据库：`postgresql://localhost:5432/postgres`，schema `data`
> 复审对象：`daily_metrics`、`channel_daily_metrics`、`adjust_daily_metrics`
> 数据来源定位（用户口径）：
> - `daily_metrics`、`channel_daily_metrics` —— **BI 中间表同步**（期望态；当前由 seed 脚本定义，库内 0 行）
> - `adjust_daily_metrics` —— **API 归因落库**（`adjust-sync.ts` 全列定时同步 + `api-ingest.ts` 查询回填，库内有真实数据）
>   - ⚠ **2026-09-08 结构升级**：已从「3 维 7 指标」升级为「5 维 16 指标 + `synced_at`（共 22 列）」并 `--reset` 清空重同步，详见 [`doc/adjust-metrics-optimization-plan.md`](./adjust-metrics-optimization-plan.md)。本文档已按新结构更新。
> 验证方式：直连 PG 查 `information_schema.columns`（结构/精度）+ 三表 `count(*)`、维度基数、指标聚合与稀疏度（见文末）
> 关联文档：本次是 [`doc/data-review.md`](./data-review.md) 的再复审，重点补齐「实体导出 + 逐字段标注」与「维度是否互补/是否重复统计」两问。

---

## 一、结论摘要

1. **实体导出**：三张表共 **44 个字段**（`daily_metrics` 9 + `channel_daily_metrics` 13 + `adjust_daily_metrics` 22），结构已从库内 `information_schema` 逐列核准（含类型、精度、主键、默认值），见第二节。
2. **维度互补性**：三表在**维度**上几乎正交（唯一共享列是 `stat_date`），不存在「维度完全一样」的表 —— 从维度角度，三表各有独立存在理由。
3. **真正的冗余风险不在维度、在指标**：`channel_daily_metrics` 与 `adjust_daily_metrics` 覆盖**几乎同一条投放漏斗**（展示→点击→下载/安装→注册→FD→RD + 花费），但两者维度口径无法对齐（媒体口径 vs 归因口径、5 市场 vs 242 国家）。**同一指标各存一份、口径又对不上、还不能交叉验证**，才是「重复统计却无意义」的隐患点。（注：adjust 侧已于 09-08 补齐真实展示/点击/会话/花费/首存数据，channel 侧仍为 0 行，桥接缺口依旧。）
4. **`daily_metrics` 无争议**：唯一的经营结果层，指标（GMV/订单/活跃/新增/转化率/客单价）与另两表**零重叠**，维度（国内销售大区×销售渠道）也独有，是纯粹的维度+指标补充。
5. **现状**：仅 `adjust_daily_metrics` 有数据（**997,223 行 / 130 天**，2026-05-01 ~ 09-07，5 维 16 指标）；两张 BI 中间表为空，互补性目前只是「潜在设计」，尚未落地。

一句话：**维度设计是互补的、合理的；但 channel 与 adjust 的指标高度重叠且无桥接，需要明确分工或建立映射，否则会变成两套对不上的重复数字。**

---

## 二、数据实体导出（逐字段标注）

### 2.1 `data.daily_metrics` —— 经营结果日指标（BI 中间表 · 当前 0 行）

- **定位**：后链路「经营结果层」，回答「最终生意做得怎么样」。只含结果，不含投放投入。
- **主键**：`(stat_date, region, channel)`　**索引**：`idx_dm_date(stat_date)`
- **来源**：`scripts/seed-demo-data.ts`（期望改为 BI 中间表同步）

| # | 字段 | 类型 | 角色 | 意义标注 | 备注 |
|---|---|---|---|---|---|
| 1 | `stat_date` | date | 维度·PK | 统计日期 | 与另两表唯一同名同义列 |
| 2 | `region` | text | 维度·PK | **销售大区**：华东/华北/华南/华中/西南/西北/东北 | ⚠ 与 `channel_daily_metrics.region`（投放市场）**同名不同义** |
| 3 | `channel` | text | 维度·PK | **销售渠道/成交端**：app/miniapp/web/offline | ⚠ 与 `ad_channel`（广告媒体）、`network`（归因渠道）是三个不同渠道概念 |
| 4 | `gmv` | numeric(14,2) | 指标·sum | 商品交易总额（元） | 独有，另两表无收入侧指标 |
| 5 | `orders` | integer | 指标·sum | 支付订单总数（单） | 独有 |
| 6 | `active_users` | integer | 指标·sum | 日活用户数（人，按天累加） | 独有 |
| 7 | `new_users` | integer | 指标·sum | 新注册用户数（人） | 与投放侧「注册」概念相关但口径不同（经营侧新增用户 vs 投放侧注册事件） |
| 8 | `conversion_rate` | numeric(6,4) | 指标·avg | 转化率（下单用户/活跃用户，平均值口径） | 可由 orders/active_users 部分派生，口径需固化 |
| 9 | `avg_order_value` | numeric(10,2) | 指标·avg | 客单价（元） | 可由 gmv/orders 派生 |

### 2.2 `data.channel_daily_metrics` —— 投放渠道日漏斗（BI 中间表 · 当前 0 行）

- **定位**：前链路「投放执行层」，回答「花了多少钱、买到什么」。唯一把**花费**与**含金额的后链路事件**放在同一张表的实体，漏斗最完整。
- **主键**：`(stat_date, ad_channel, platform, region)`　**索引**：`idx_cdm_date(stat_date)`、`idx_cdm_channel(ad_channel)`
- **来源**：`scripts/seed-acquisition-data.ts`（期望改为 BI 中间表同步）；配套维表 `data.channel_campaigns`（同样 0 行）

| # | 字段 | 类型 | 角色 | 意义标注 | 备注 |
|---|---|---|---|---|---|
| 1 | `stat_date` | date | 维度·PK | 统计日期 | — |
| 2 | `ad_channel` | text | 维度·PK | **广告投放媒体**：Meta/X/TikTok | 媒体侧口径，与 adjust `network` 需映射才能对齐 |
| 3 | `platform` | text | 维度·PK | **承接端**：app（下载）/web（落地页） | ✅ adjust 侧无「承接端」维度（其 `os_name` 是操作系统 android/ios，非同一概念），是本表独有 |
| 4 | `region` | text | 维度·PK | **投放市场**：北美/欧洲/东南亚/拉美/日韩 | ⚠ 与 `daily_metrics.region`（国内大区）同名不同义；粗粒度，无国家级 |
| 5 | `spend` | numeric(12,2) | 指标·sum | 广告花费（美元，媒体自报） | 与 adjust `cost`/`adjust_cost`（MMP 口径，实测 $3,400）重叠，`network_cost` 仍全 0；两者本应有差异 |
| 6 | `impressions` | bigint | 指标·sum | 广告展示次数 | 与 adjust `impressions` 重叠 |
| 7 | `clicks` | bigint | 指标·sum | 广告点击次数 | 与 adjust `clicks` 重叠 |
| 8 | `downloads` | integer | 指标·sum | app 端下载次数（web 端为 0） | 与 adjust `installs` 概念对应（下载 vs 归因安装） |
| 9 | `registrations` | integer | 指标·sum | 新增注册用户数（人） | 与 adjust `register_cnt`（Register 事件数）重叠，**users vs events 口径不同** |
| 10 | `fd_users` | integer | 指标·sum | 首次充钱用户数（人，First Deposit） | 与 adjust `first_deposit_cnt` 重叠 |
| 11 | `fd_amount` | numeric(14,2) | 指标·sum | 首充金额（美元） | ✅ adjust 侧无金额，是本表独有 |
| 12 | `rd_users` | integer | 指标·sum | 召回再充用户数（人，Re-Deposit） | 与 adjust `recall_deposit_cnt` 重叠 |
| 13 | `rd_amount` | numeric(14,2) | 指标·sum | 召回充钱金额（美元） | ✅ adjust 侧无金额，是本表独有 |

### 2.3 `data.adjust_daily_metrics` —— Adjust 归因日指标（API 落库 · 997,223 行 · 09-08 升级为 5 维 16 指标）

- **定位**：「归因层」，回答「第三方 MMP 口径下，各渠道×各国家×各 OS×各计划的流量质量与成本如何」。唯一有真实数据的表。
- **主键**：`(stat_date, network, country_code, os_name, campaign_network)`（5 维）　**索引**：`idx_adm_date(stat_date)`、`idx_adm_network(network)`
- **来源**：`lib/server/integrations/adjust-sync.ts`（**全列按天分块同步**，网络层指数退避重试，`--reset` 可清空重建）与 `api-ingest.ts`（API 查询未命中时按语义模型分解落库），二者同 5 维主键、互相幂等覆盖
- **数据范围**：2026-05-01 ~ 2026-09-07（130 天，09-08 回补 0 失败；含当日补齐 5/1~5/30 使 5 月成整月，按月统计量级一致）

| # | 字段 | 类型 | 角色 | 意义标注 | 现状（全表聚合 / 非零行） |
|---|---|---|---|---|---|
| 1 | `stat_date` | date | 维度·PK | 统计日期（报告时区 UTC+8） | 130 天 |
| 2 | `network` | text | 维度·PK | **归因渠道**（含付费+自然量） | 273 值；web 占安装 76% |
| 3 | `country_code` | text | 维度·PK | ISO 3166-1 alpha-2 国家码 | 242 值（国家级） |
| 4 | `os_name` | text | 维度·PK | **操作系统**（🆕 新增，DEFAULT ''） | 19 值；android 46.8M / ios 7.11M / windows 4.53M |
| 5 | `campaign_network` | text | 维度·PK | **渠道下计划名**（🆕 新增，DEFAULT ''） | 19,064 值（最细投放粒度） |
| 6 | `impressions` | bigint | 指标·sum | 展示量 | **3,087,927,937**；178,936 行 >0 |
| 7 | `clicks` | bigint | 指标·sum | 点击量 | **2,237,704,401**；193,788 行 >0 |
| 8 | `installs` | bigint | 指标·sum | 归因安装数 | **58,948,374**；65,923 行 >0 |
| 9 | `sessions` | bigint | 指标·sum | 会话数（含老用户活跃） | **1,090,723,534**；676,616 行 >0 |
| 10 | `base_sessions` | bigint | 指标·sum | 基础会话数（🆕） | **1,029,672,500**；662,933 行 >0 |
| 11 | `organic_installs` | bigint | 指标·sum | 自然量安装（🆕） | **5,058,206**；6,428 行 >0 |
| 12 | `non_organic_installs` | bigint | 指标·sum | 非自然量安装（🆕） | **53,882,844**；58,092 行 >0 |
| 13 | `reattributions` | bigint | 指标·sum | 再归因数（🆕，老用户重新归因） | **2,109,984**；23,371 行 >0 |
| 14 | `register_cnt` | bigint | 指标·sum | Register 自定义事件数 | **5,987,314**；58,078 行 >0 |
| 15 | `first_deposit_cnt` | bigint | 指标·sum | FirstDeposit 自定义事件数 | **3,782,840**；55,270 行 >0 |
| 16 | `recall_deposit_cnt` | bigint | 指标·sum | RecallDeposit 自定义事件数 | **1,162,249**；31,547 行 >0（5 月无 RD，均在近月） |
| 17 | `daus` | bigint | 指标·sum | 日活用户数（🆕） | **485,205,851**；655,265 行 >0 |
| 18 | `rejected_installs` | bigint | 指标·sum | 拒绝/作弊安装数（🆕，反作弊） | **739,456**；18,484 行 >0 |
| 19 | `cost` | numeric(18,4) | 指标·sum | 归因成本（🆕，美元） | **$3,399.64**；仅 125 行 >0（集中于 iOS DSP 计划） |
| 20 | `adjust_cost` | numeric(18,4) | 指标·sum | Adjust 侧成本（🆕） | **$3,399.64** |
| 21 | `network_cost` | numeric(18,4) | 指标·sum | 渠道回传成本（未配置支出回传时为 0） | **全表 0**（上游未回传） |
| 22 | `synced_at` | timestamptz | 元数据 | 同步时间（默认 now()） | ✅ 新鲜度标记 |

> 🆕 = 09-08 升级新增列（相较旧「3 维 7 指标」）。旧表 `impressions/clicks/sessions/first_deposit_cnt/network_cost` 曾全表 0，根因是「全列同步从未真正跑过」（旧行实为 `api-ingest` 单指标扩维零散写入）；重同步后除 `network_cost` 外均落到真实值。

**Top 网络画像（按安装量）**：web 44.79M（自然/直接量，占 76%）、Organic 5.05M、Oppo Ads 1.91M、gadmobe-apk 1.76M、Chuanyin Ads 1.59M、Gadmobe apk-0818 0.78M、Google Ads H5-Inhouse 0.55M、Untrusted Devices 0.55M。
**OS × 成本画像**：android 安装 46.8M（成本 $267）、ios 安装 7.11M（成本 **$3,133，占全表花费 92%**）、windows 4.53M、linux 0.30M、macos 0.16M。
→ 花费高度集中在少量 iOS DSP 计划（`cost` 仅 125 行 >0）；`web/Organic/Untrusted Devices` 等非付费来源与付费网络**仍混在同一 `network` 字段**，但已可用 `organic_installs`/`non_organic_installs` 两列做自然量/付费量分层。

---

## 三、维度互补性 / 合理性分析（本次复审重点）

> 判定原则（用户口径）：**各表应是数据维度的补充；若两表能做的维度统计完全一样，则其中一张没有意义。**

### 3.1 维度正交性：三表几乎不共享维度（好）

| 维度概念 | daily_metrics | channel_daily_metrics | adjust_daily_metrics |
|---|---|---|---|
| 时间 | `stat_date` | `stat_date` | `stat_date` |
| 地理 | `region`＝国内销售大区（7） | `region`＝投放市场（5，粗） | `country_code`＝国家（242，细） |
| 渠道 | `channel`＝销售渠道（4） | `ad_channel`＝广告媒体（3） | `network`＝归因渠道（273） |
| 承接端/OS | — | `platform`（app/web 承接端） | `os_name`（android/ios/windows 操作系统，19） |
| 投放粒度 | — | — | `campaign_network`（渠道下计划名，19,064，最细） |

- **唯一共享维度仍是 `stat_date`**；地理、渠道、承接端/OS 三类维度在三表里**概念/取值域完全不同**（adjust 的 `os_name` 是操作系统 android/ios，与 channel 的 `platform`＝app/web 承接端**并非同一概念**）。adjust 侧 09-08 新增 `os_name`/`campaign_network` 两维，投放粒度细化到「计划级」，是三表中维度最丰富者。
- 结论：**不存在「维度完全一样」的两张表**，从维度角度看三表都不可被另一张替代 —— 满足「维度补充」的设计原则。
- 副作用：维度全不对齐 → **三表无法直接 join**，「投放→归因→经营」全链路打通缺桥接键（`region` 同名不同义更是陷阱）。

### 3.2 指标重叠：channel 与 adjust 高度重合（风险点）

| 漏斗环节 | daily_metrics | channel_daily_metrics | adjust_daily_metrics | 是否重叠 |
|---|:--:|:--:|:--:|---|
| 展示 impressions | — | ✓（0 行） | ✓ **30.9 亿** | **重叠**（adjust 已有真实值） |
| 点击 clicks | — | ✓（0 行） | ✓ **22.4 亿** | **重叠**（adjust 已有真实值） |
| 下载/安装 | — | `downloads`（0 行） | `installs` **5895 万** | **概念重叠**（口径不同） |
| 注册 | — | `registrations`(users，0 行) | `register_cnt`(events) **599 万** | **重叠**（users vs events） |
| 首存 FD | — | `fd_users`+`fd_amount`（0 行） | `first_deposit_cnt` **378 万** | **重叠**（channel 多金额） |
| 复存 RD | — | `rd_users`+`rd_amount`（0 行） | `recall_deposit_cnt` **116 万** | **重叠**（channel 多金额） |
| 花费/成本 | — | `spend`(媒体自报，0 行) | `cost`/`adjust_cost` **$3,400**、`network_cost`(全 0) | **重叠**（adjust 已有真实成本） |
| 会话/活跃 | — | — | `sessions` **10.9 亿**、`base_sessions`、`daus` **4.85 亿** | adjust 独有 |
| 自然/付费分层 | — | — | `organic_installs` 506 万 / `non_organic_installs` 5388 万 | adjust 独有（🆕） |
| 反作弊 | — | — | `rejected_installs` **74 万** | adjust 独有（🆕） |
| GMV/订单/活跃/新增/转化/客单 | ✓（0 行） | — | — | daily 独有 |

**读法**：
- `daily_metrics` 与另两表**零指标重叠** → 纯补充，最没有争议。
- `channel_daily_metrics` 与 `adjust_daily_metrics` **在 7 个漏斗环节上重叠**；09-08 升级后 adjust 侧展示/点击/会话/首存/成本均已落到真实值，而 channel 侧仍 0 行，重叠指标目前只有 adjust 一套数字。各自独有：
  - channel 独有：`platform`（app/web 承接端）、`fd_amount`/`rd_amount`（充值金额）、`spend`（媒体自报花费）
  - adjust 独有：`country_code`（国家级）、`os_name`/`campaign_network`（OS+计划级）、`sessions`/`daus`、`organic`/`non_organic_installs`（自然量分层）、`rejected_installs`（反作弊）、`installs`/`cost`（MMP 口径）

### 3.3 那 channel 与 adjust 到底是不是「重复统计」？

**不是完全重复，但重叠面过大、且当前无法互补落地。** 三点判断：

1. **口径本质不同，理论上应并存**：channel 是**投放平台自报口径（media-side）**，adjust 是**第三方归因口径（MMP-side）**。广告行业里这两套数字**本就应该对不上**（自归因偏差、自然量混入、跨端归因差异），**对比二者差异本身就是核心价值**（判断哪个渠道在虚报/漏报）。所以「两表都存展示/点击/注册/FD」在设计上**可以**是合理的补充。

2. **但互补的前提当前都不成立**：
   - **数据前提**：`channel_daily_metrics` 为 0 行 → 现在只有 adjust 一套数字，谈不上「对比」，channel 的投放漏斗价值完全没发挥。
   - **桥接前提**：`ad_channel`(Meta/X/TikTok) ↔ `network`(273 个) 无映射，`region`(5 市场) ↔ `country_code`(242 国) 无映射 → 即便两表都有数据，也**无法按同一维度交叉验证**，只能各算各的。

3. **真正的隐患**：若 channel 从 BI 同步后仍无桥接，那么「展示/点击/注册/FD/RD」这几个重叠指标就会变成**两套维度对不上、数值也对不上、又不能互相校验的重复数字** —— 这正是用户担心的「重复统计却无意义」，比「维度完全一样」更隐蔽。

### 3.4 判定结论

| 表对 | 维度是否重复 | 指标是否重复 | 是否「无意义冗余」 | 处置方向 |
|---|---|---|---|---|
| daily ↔ channel | 否（正交） | 否（零重叠） | **否**，纯补充 | 保持 |
| daily ↔ adjust | 否（正交） | 否（零重叠） | **否**，纯补充 | 保持 |
| **channel ↔ adjust** | 否（口径/粒度不同） | **高度重叠（7 环节）** | **有条件成立**：能桥接→互补(media vs MMP 校验)；不能桥接→重复 | **建桥接 或 明确分工** |

---

## 四、整体 Review 总结

### 4.1 合理之处（保留）

1. **三层分离符合投放归因范式**：投放执行（channel）→ 归因（adjust）→ 经营结果（daily）分层独立，口径互不污染。
2. **维度设计正交、无冗余表**：三表共享列仅 `stat_date`，没有哪张表能被另一张在维度上完全替代 —— 满足「维度补充」原则。
3. **`daily_metrics` 是干净的结果层**：与投放漏斗零指标重叠，独立价值清晰。
4. **adjust 工程机制成熟（09-08 升级）**：5 维主键幂等 upsert、**按天分块同步 + 网络层指数退避重试**（累计 130 天回补 0 失败）、事件 slug 动态校验、`synced_at` 新鲜度标记、`--reset` 清空重建、语义模型（16 指标 / 5 维）与 `cause.metrics`（13 条含派生率）自动挂载。

### 4.2 关键问题（按影响排序）

> 状态列基于 09-08 adjust 升级后的库内实测（997,223 行 / 130 天）：🟢 已解决　🟡 部分解决　🔴 未解决。

| 级别 | 问题 | 证据 | 影响 | 09-08 后状态 |
|---|---|---|---|---|
| **P0** | **channel↔adjust 指标重叠但无桥接** | `ad_channel`↔`network`(273)、`region`↔`country_code`(242) 无映射；channel 表 0 行 | 两表重叠指标沦为「对不上的重复数字」，media vs MMP 交叉验证价值无法兑现 | 🔴 **未解决**（adjust 侧已就绪，待 channel 落数 + 建桥接） |
| **P0** | **成本缺失** | 旧表仅 `network_cost`（全 0）；新增 `cost`/`adjust_cost` 实测 **$3,399.64**（iOS DSP 计划，125 行） | 旧口径 CPI/CPA 不可算 | 🟢 **已解决**（cost 落到真实值，CPI/CPA 可算；network_cost 仍 0 属上游未回传，正常） |
| **P0** | **收入/ROAS 缺失** | `revenue`/`all_revenue`/`roas` 受账户权限门控（探活 loc=revenue 无权限） | ROAS/端到端 ROI 不可算 | 🔴 **未解决**（需申请 Adjust 收入指标权限，见优化计划后续项） |
| **P0** | **首存事件全 0** | 旧表 `first_deposit_cnt` 全 0 | FD 转化率、首存成本不可算 | 🟢 **已解决**（重同步后 **378 万**，55,270 行 >0） |
| **P1** | **前置漏斗全 0** | 旧表 `impressions/clicks/sessions` 全 0 | CTR/CPM/会话活跃不可算 | 🟢 **已解决**（impressions 30.9 亿 / clicks 22.4 亿 / sessions 10.9 亿） |
| **P1** | **维度口径三表不统一** | `region` 同名不同义；`channel/ad_channel/network` 三个渠道概念；无统一维度字典 | 全链路 join 不可行，问答易选错表/错维度 | 🟡 **部分**（adjust 侧维度更丰富：+os_name/campaign_network；跨表字典仍缺） |
| **P1** | **命名与计量单位不一致** | `registrations`(users) vs `register_cnt`(events)；`downloads` vs `installs`；`spend` vs `cost` | 同义指标跨表对不上，语义层易误聚合 | 🟡 **部分**（adjust 内部已统一为 api slug；跨表命名仍需对照字典） |
| **P2** | **自然量与付费量未分层** | 旧表 `network` 混 web/Organic/Untrusted 与付费网络，无标记 | 付费效率分析被自然量稀释 | 🟢 **已解决**（新增 `organic_installs` 506 万 / `non_organic_installs` 5388 万 两列 + `campaign_network` 计划维） |
| **P2** | **派生率不可执行** | `cause.metrics.formula` 全仓无执行代码；语义模型 `agg="none"` 被 operator 目录跳过 | ctr/ecpi/fd_rate 等比率无法直接查 | 🟡 **部分**（13 条 formula 已登记为目录，仍缺 formula 执行引擎） |
| **P3** | **空表无监控 / 新鲜度不统一** | 两张 BI 表 0 行且无 `synced_at`；仅 adjust 有新鲜度标记 | 问答静默返回空结果，无告警 | 🔴 **未解决** |

### 4.3 建议（围绕「让维度互补真正落地」）

**A. 先决策 channel 与 adjust 的分工（解决 P0 重叠）** —— 二选一：
- **方案①（推荐·交叉验证）**：建立**维度桥接表** `dim_channel_network_map`（`ad_channel`↔`network`）与 `dim_region_country_map`（`region`↔`country_code` 归属），让两表能在「媒体口径 vs 归因口径」上对齐，把重叠指标变成**差异分析**（谁在虚报/漏报）——此时重叠是有意义的补充。
- **方案②（明确边界·去重叠）**：若不做桥接，则给两表**划清独占指标**：channel 只保留 adjust 没有的（`platform`、`fd_amount`/`rd_amount`、`spend`），adjust 只保留 channel 没有的（`country_code`、`sessions`、自然量 network），**重叠的计数指标指定唯一权威源**（如注册/FD/RD 人数以 adjust 为准，金额以 channel 为准），避免同名指标两处各存一份。

**B. 打通钱的两端（成本已就绪，收入待权限）**：成本侧 adjust `cost`/`adjust_cost` 已落真实值（$3,400），CPI/CPA 可算；**收入侧**需申请 Adjust `revenue`/`all_revenue`/`roas` 指标权限（当前账户被门控），或在 `orders` 明细补归因关联键使 GMV 按来源归集，方能算 ROAS/端到端 ROI。

**C. ~~修数据全 0~~（09-08 已解决）**：旧全 0 根因是「全列同步从未真正跑过」——旧 19,994 行实为 `api-ingest` 单指标扩维查询零散写入、多数列停留默认 0。已通过 `adjust-sync.ts` 全列按天分块重同步（`--reset`）修复：impressions/clicks/sessions/first_deposit/cost 全部落到真实值（仅 `network_cost` 仍 0，属上游未回传）。

**D. 建统一维度字典（解决 P1 口径）**：沉淀 network 字典（organic/non_organic 已由新列区分）、国家↔市场↔大区映射、渠道概念对照（channel/ad_channel/network）、OS 与 campaign_network 口径，并统一命名与计量单位（users vs events 显式区分）。

**E. 治理（解决 P3）**：三表统一 `synced_at`/数据版本字段；对空表与新鲜度建监控告警，防问答静默空答。

---

## 五、验证方式

- 连接：`psql -h localhost -U sheliming -d postgres -P pager=off`（PGPASSWORD 取自 `.env` 的 `DATABASE_URL`）。
- 表清单：`information_schema.tables WHERE table_schema='data'` → 7 张（含 regions/products/orders/channel_campaigns）。
- 结构/精度：`information_schema.columns`（三表 **44 列**：daily 9 + channel 13 + adjust 22，含 numeric_precision/scale）；adjust 主键 `(stat_date,network,country_code,os_name,campaign_network)`、索引 `idx_adm_date`/`idx_adm_network`（`pg_indexes` 核准），DDL 来自 `adjust-sync.ts`（其余两表 `seed-demo-data.ts` / `seed-acquisition-data.ts`）。
- 数据量：三表 `count(*)` + `min/max(stat_date)`；adjust 全量聚合（installs 5895 万 / impr 30.9 亿 / clicks 22.4 亿 / sessions 10.9 亿 / daus 4.85 亿 / register 599 万 / fd 378 万 / rd 116 万 / cost $3,399.64 / network_cost 0）、稀疏度（`FILTER (WHERE >0)`：installs 65,923、impr 178,936、fd 55,270、cost 仅 125、network_cost 0）、维度基数（273 networks / 242 countries / 19 os / 19,064 campaign_network / 130 days）、Top8 网络、OS 拆分（android 46.8M / ios 7.11M 含 92% 花费 / windows 4.53M）、按月分布（5~8 月各整月、9 月截至 07 日）。
- 上下文：`lib/server/semantic/semantic-query.ts`（`DEMO_SEMANTIC_MODELS` 三表已注册的指标/维度口径）、`lib/server/integrations/adjust-sync.ts`（升级后同步时自动挂载语义模型 16 指标 / 5 维 + 补录 `cause.metrics` 13 条）、`lib/server/integrations/api-ingest.ts`（API 落库建表逻辑，指标列 NUMERIC(18,4)）、`prompts.ts`（「BI 中间表同步 / API 查询入库，各源平级」的口径说明）。
- 仍存核查缺口：~~全 0 根因~~（已定位为「全列同步从未真正跑过」并于 09-08 重同步修复）；**收入指标**（revenue/roas）受账户权限门控待申请；`cost` 仅 125 行 >0（仅少数 iOS DSP 计划回传 Adjust 侧成本，属上游覆盖范围，非缺陷）；BI 中间表同步链路是否已实装（当前两表 0 行，未见 BI 抽取代码，仍为 seed 定义）。
