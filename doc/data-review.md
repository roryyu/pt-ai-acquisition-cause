# data schema 投放数据实体评审

> 评审日期：2026-09-08
> 数据库：postgresql://
>
> [localhost:5432/postgres](https://localhost:5432/postgres)
>
> （schema: 
>
> `data`
>
> ）
> 评审对象：
>
> `daily_metrics`
>
> 、
>
> `adjust_daily_metrics`
>
> 、
>
> `channel_daily_metrics`
>
>  三个数据实体
> 评审视角：流量投放运营业务
> 数据现状：直接查询 
>
> `information_schema`
>
>  / 
>
> `pg_class`
>
>  与三表聚合统计（见文末 "验证方式"）



***

## 一、结论摘要

三个实体构成 "投放执行 → 归因 → 经营结果" 的三层模型，**分层设计思路合理**，但当前存在三类关键问题：



1. **成本数据整体缺失**：`adjust_daily_metrics.network_cost` 全表为 0，`channel_daily_metrics.spend` 所在表为空 → CPI/CPA/ROAS 等投放核心指标无法计算；

2. **收入侧与投放链路未打通**：三张表均无 "收入 / GMV × 花费" 的统一关联口径，端到端 ROI 不可算；

3. **关键事件与前置漏斗缺失**：`first_deposit_cnt`（首存）全 0、`impressions/clicks/sessions` 全 0 → FD 转化率、CTR、ECPI 均不可算。

此外，三表维度口径（region /country\_code/channel /network/ad\_channel）互不统一且无桥接映射，归因链路无法全链路 join；`daily_metrics`、`channel_daily_metrics`、`regions`、`orders` 等表当前为空，仅 Adjust 归因表有真实数据。



***

## 二、数据实体总览



| 维度   | daily\_metrics（经营结果）          | adjust\_daily\_metrics（归因）           | channel\_daily\_metrics（投放执行）               |
| ---- | ----------------------------- | ------------------------------------ | ------------------------------------------- |
| 定位   | 区域 × 渠道 × 日的经营结果指标            | Adjust 归因平台：渠道 (network)× 国家 × 日漏斗   | 广告渠道 × 承接端 × 市场 × 日的投放漏斗（含金额）               |
| 主键   | (stat\_date, region, channel) | (stat\_date, network, country\_code) | (stat\_date, ad\_channel, platform, region) |
| 字段数  | 8                             | 12                                   | 13                                          |
| 当前行数 | **0**                         | **19,994**                           | **0**                                       |
| 数据范围 | 无（种子脚本设计 2024-08 \~ 2026-08）  | 2026-06-01 \~ 2026-09-06（98 天）       | 无（种子脚本设计 2025-08 \~ 2026-08）                |
| 数据来源 | 演示种子（seed-demo-data.ts）       | Adjust RS API 每日同步（T+1，真实数据）         | 演示种子（seed-acquisition-data.ts）              |
| 语义模型 | 未注册                           | 已注册「Adjust 投放日指标」                    | 未注册                                         |
| 配套表  | regions / products / orders   | —                                    | channel\_campaigns                          |

三个实体分别回答运营的三个问题：



* **花了多少钱、买到什么**（channel\_daily\_metrics：spend → 展示 / 点击 → 下载 → 注册 → 首存 / 复存 人数与金额）；

* **平台归因口径下流量质量如何**（adjust\_daily\_metrics：安装 → 会话 → 注册 → 首存 → 复存，渠道 × 国家）；

* **最终经营结果如何**（daily\_metrics：GMV、订单、活跃 / 新增用户、转化率、客单价）。



***

## 三、逐实体总结

### 3.1 data.daily\_metrics —— 经营结果日指标（当前为空表）



| 字段                | 类型            | 口径说明                          |
| ----------------- | ------------- | ----------------------------- |
| stat\_date        | date          | 统计日期（PK）                      |
| region            | text          | 经营区域（PK，如华东 / 西南等，非国家码）       |
| channel           | text          | 经营渠道（PK，如 app 等）              |
| gmv               | numeric(14,2) | 成交总额                          |
| orders            | integer       | 订单数                           |
| active\_users     | integer       | 活跃用户数                         |
| new\_users        | integer       | 新增用户数                         |
| conversion\_rate  | numeric(6,4)  | 转化率（口径未定义，可由 gmv/orders 部分派生） |
| avg\_order\_value | numeric(10,2) | 客单价                           |



* 定位：后链路经营结果层，只含 "结果" 不含 "投放投入"（无 spend / 展示 / 点击），无法单独支撑投放归因。

* 现状：0 行。种子脚本定义为 2024-08-01 \~ 2026-08-24 的演示数据，当前库中未灌入；语义层也未注册该表模型。

* 与投放的断层：`region` 是国内经营区域口径，与归因侧 `country_code`、投放侧 `region` 无映射关系；`channel` 与 `network`/`ad_channel` 是三个不同的渠道概念。

### 3.2 data.adjust\_daily\_metrics —— Adjust 归因日指标（唯一有真实数据的表）



| 字段                   | 类型            | 口径说明                                                                        | 现状                       |
| -------------------- | ------------- | --------------------------------------------------------------------------- | ------------------------ |
| stat\_date           | date          | 统计日期（PK，报告时区 UTC+8）                                                         | 2026-06-01 \~ 2026-09-06 |
| network              | text          | 归因渠道（PK，176 个值：web / Organic / Oppo Ads / Chuanyin Ads / Apple Search Ads…） | 有值                       |
| country\_code        | text          | ISO 3166-1 alpha-2 小写国家码（PK，195 个值）                                         | 有值                       |
| impressions          | bigint        | 展示量（部分渠道不回传）                                                                | **全表 0**                 |
| clicks               | bigint        | 点击量                                                                         | **全表 0**                 |
| installs             | bigint        | 归因安装数                                                                       | **4,557.7 万**            |
| sessions             | bigint        | 会话数                                                                         | **全表 0**                 |
| register\_cnt        | bigint        | Register 自定义事件数                                                             | **436.3 万**              |
| first\_deposit\_cnt  | bigint        | FirstDeposit 自定义事件数                                                         | **全表 0**                 |
| recall\_deposit\_cnt | bigint        | RecallDeposit 自定义事件数                                                        | **113.4 万**              |
| network\_cost        | numeric(14,4) | 渠道回传成本（未配置支出数据时为 0）                                                         | **全表 0**                 |
| synced\_at           | timestamptz   | 同步时间                                                                        | 有值（T+1）                  |

关键数据画像：



* 总量：install 45,576,780、register 4,363,348、RD 1,133,546；FD、impressions、clicks、sessions、cost 均为 0。

* 稀疏度：installs>0 的行占 80.9%（16,172/19,994），register>0 占 41.4%，RD>0 占 29.7%。

* 来源集中：`web` 安装 3,426.8 万（占 75.2%），web + Organic 合计 3,772.9 万（82.8%）—— 付费渠道占比很小，且 web/Organic/Untrusted Devices 等非付费来源与付费网络混在同一 network 字段，无来源类型标记。

* 覆盖：每 network 平均覆盖 7.5 个国家码，最多 161 个（如 Organic 几乎覆盖全部国家），大量 network×country 行为稀疏 / 0 值行。

* 工程机制：同步链路含事件 slug 动态校验（上游改名预警不阻断）、幂等 upsert、每日回补 3 天覆盖 T+1 修正窗口，机制本身成熟。

### 3.3 data.channel\_daily\_metrics —— 投放渠道日漏斗指标（当前为空表）



| 字段                     | 类型                  | 口径说明                          |
| ---------------------- | ------------------- | ----------------------------- |
| stat\_date             | date                | 统计日期（PK）                      |
| ad\_channel            | text                | 广告渠道（PK）                      |
| platform               | text                | 承接端 / 平台（PK，如 iOS/Android/H5） |
| region                 | text                | 市场（PK，与经营 region 同名词不同义）      |
| spend                  | numeric(12,2)       | 广告花费                          |
| impressions / clicks   | bigint              | 展示 / 点击                       |
| downloads              | integer             | 下载数                           |
| registrations          | integer             | 注册数                           |
| fd\_users / fd\_amount | int / numeric(14,2) | 首存人数 / 首存金额                   |
| rd\_users / rd\_amount | int / numeric(14,2) | 复存人数 / 复存金额                   |



* 定位：投放执行层，是唯一把 "花费" 与 "后链路事件（含金额）" 放在同一张表的实体，漏斗最完整（下载→注册→首存→复存，人数 + 金额并列）。

* 现状：0 行（种子脚本设计 2025-08-25 \~ 2026-08-25 演示数据，未灌入）。

* 配套 `channel_campaigns`（计划表：campaign\_no、objective、status、daily\_budget、total\_spend 等）同样为空，且 channel\_daily\_metrics 中无 campaign 维度字段，两表无法按计划粒度关联。



***

## 四、合理性分析（流量投放运营视角）

### 4.1 合理之处



1. **三层分离设计符合投放归因标准范式**：投放执行（channel\_daily\_metrics）→ 归因（adjust\_daily\_metrics）→ 经营结果（daily\_metrics）分层独立，口径互不污染，是成熟数仓分层做法。

2. **归因表维度选择覆盖基本盘**：(日 × 网络 × 国家) 粒度 + 安装 / 会话 / 注册 / 首存 / 复存事件漏斗，覆盖了 "从哪来（渠道）→ 在哪些市场 → 转化到哪一步" 的基本归因分析；`synced_at` 新鲜度标记、幂等 upsert、事件 slug 校验等工程机制成熟。

3. **投放表把金额与人数并列**：`fd_users/fd_amount`、`rd_users/rd_amount` 并存，可支持人均首存、复存金额等 "买量质量" 分析，这是投放运营判断渠道质量的关键信息。

4. **有维度建模意识**：配套 regions/products/orders/channel\_campaigns 维表与明细表，方向正确。

### 4.2 问题与缺失（按影响程度分级）

#### P0 —— 阻断核心归因结论



| # | 问题              | 证据                                                                                                                                | 影响                                                        |
| - | --------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1 | **成本口径整体缺失**    | `network_cost` 全表 0（已知问题：需渠道接入 Adjust 合作伙伴广告支出 API / AppView cost integration，读者角色无法完成，需管理员推动）；`spend` 所在表为空                      | 无法计算 CPI / CPA / ECPI / ROAS，投放优化的核心依据缺失                  |
| 2 | **收入侧与投放链路未打通** | 三表均无 revenue 与投放关联；`daily_metrics.gmv` 为 region×channel 粒度且表空，与 network/country 无桥接；Adjust 官方 `all_revenue`、`roas_d1/d3/d7` 指标未同步 | 端到端 ROI（收入 / 花费）不可算，归因系统最核心产出缺失                           |
| 3 | **首存事件全 0**     | `first_deposit_cnt` 全 0（疑为事件 slug 上游改名，同步有预警但未阻断）                                                                                 | FD / 注册转化率、首存成本不可算；语义模型中已定义的 `metric_adjust_fd_rate` 恒为 0 |

#### P1 —— 影响投放优化深度



| # | 问题               | 说明                                                                                                                                         |
| - | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 4 | 前置漏斗字段全 0        | impressions/clicks/sessions 全表 0，CTR / CPM / 会话活跃等前置指标不可算；"部分渠道不回传" 解释不了全表全 0，更像报表列映射或账户指标未开通，需排查                                          |
| 5 | 缺 OS/platform 维度 | adjust 侧无 platform，无法做 iOS/Android 双端对比归因；channel 侧有 platform，两侧粒度不对齐                                                                      |
| 6 | 缺计划 / 素材粒度       | 归因只到 network（渠道）级，无 campaign/adgroup/creative 维度（Adjust RS API 支持但未同步）；channel\_campaigns 与 channel\_daily\_metrics 无法按计划关联（无 campaign 字段） |
| 7 | 维度口径三表不统一、无桥接    | region（经营）/country\_code（归因）/region（投放）三个地理口径；channel /network/ad\_channel 三个渠道口径，各自为政；`regions` 维表为空且无 country 映射 → 全链路 join 无法实现         |
| 8 | 来源类型未标记          | network 混有 web / Organic / Untrusted Devices / Brand-\* 等非付费来源与付费网络，无 paid/organic 标记；归因口径（first/dynamic、reattributed）未落库                  |

#### P2 —— 质量与金额口径不足



| #  | 问题            | 说明                                                                                                        |
| -- | ------------- | --------------------------------------------------------------------------------------------------------- |
| 9  | 缺留存 / 活跃质量指标  | Adjust 官方有 `retention_rate_d1/d3/d7`、`daus`，未同步；无法评估买量质量与 LTV 前瞻                                          |
| 10 | 金额口径不完整、币种未定义 | adjust 侧无 FD/RD 金额（channel 侧有但空表）；network\_cost 语义模型标注 "美元"，spend/fd\_amount/rd\_amount 币种未定义，多市场跨币种分析不可靠 |

#### P3 —— 数据治理



| #  | 问题         | 说明                                                                                                                                                    |
| -- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11 | 空表无监控      | daily\_metrics /channel\_daily\_metrics/regions /orders/channel\_campaigns 全空，问答类产品会静默返回空结果；缺表级数据新鲜度与行数告警                                             |
| 12 | 同步时间戳不统一   | 仅 adjust 表有 synced\_at，另两张表无同步时间 / 版本字段                                                                                                               |
| 13 | 命名与口径不统一   | register\_cnt vs registrations、fd\_users vs first\_deposit\_cnt、recall\_deposit\_cnt vs rd\_users；且 adjust 侧为 "事件数"（cnt），channel 侧为 "用户数"（users），语义不同 |
| 14 | 无修正 / 重算标记 | Adjust T+1 修正窗口内数据被 upsert 覆盖，无法追溯修正前后差异                                                                                                              |
| 15 | 冗余与口径不明    | conversion\_rate、avg\_order\_value 可部分派生（gmv/orders），且 conversion\_rate 口径（订单 / 用户？）未定义                                                               |



***

## 五、补充建议（按优先级）

### P0 先打通钱的两端



1. **补成本**：推动管理员接入 Adjust 合作伙伴广告支出 API / AppView cost integration，或从各投放平台拉真实 spend 入 `channel_daily_metrics`；同时排查 `network_cost` 同步链路。

2. **补收入**：同步 Adjust `all_revenue` / `roas_d1/d3/d7`；或在 `orders` 明细上补充归因关联键（device\_id /click\_id/install 时间窗），使 GMV 能按归因来源归集。

3. **修首存事件**：核实 `firstdeposit_events` slug 是否被上游改名，修正后复跑同步。

### P1 补齐投放优化维度



1. 排查 impressions/clicks/sessions 全 0 根因（CSV 列映射、账户指标权限）。

2. adjust 侧增加 `platform` 维度；同步粒度细化到 campaign/adgroup/creative（RS API 支持 `campaign_network` 等维度）。

3. 建立统一维度字典：network 字典（类型 / 付费标记）、国家与 region 映射（补全 `regions` 维表）、channel 字典，打通三表口径。

4. 增加 app 维度（多 App / 多包区分，sync 参数中未见 app\_token）。

### P2 补充质量与金额



1. 同步留存（retention\_d1/d3/d7）、dau 等质量指标。

2. 金额字段明确币种 / 汇率口径；统一命名（cnt vs users）并写入口径字典。

### P3 治理



1. 三表统一 `synced_at` / 数据版本字段；建立空表与新鲜度监控告警（问答产品防静默空答）。

2. 派生列（conversion\_rate、avg\_order\_value）改为计算字段或明确口径。



***

## 六、验证方式



* 连接：`psql -h localhost -U sheliming -d postgres`（PGPASSWORD 从用户提供连接串获取）。

* 结构：`\d data.daily_metrics` / `\d data.adjust_daily_metrics` / `\d data.channel_daily_metrics`；`information_schema.tables` 枚举 data schema 全部 7 张表（含 regions/products/orders/channel\_campaigns）。

* 数据量：三表 `count(*)` 与 `min/max(stat_date)`；adjust 表全量聚合（impr/clicks/installs/sessions/register/fd/rd/cost 求和）、稀疏度（`FILTER (WHERE >0)`）、维度计数（176 networks / 195 countries）、Top15 网络、每网络覆盖国家数分布。

* 上下文：`lib/server/integrations/adjust-sync.ts`（同步列映射与事件 slug 校验逻辑）、`scripts/seed-demo-data.ts` / `scripts/seed-acquisition-data.ts`（另两表设计意图与种子范围）、`cause.semantic_models`（已注册语义模型）、`doc/Adjust官网API与MCP对接指南-20260902.md`（cost 缺失为已记录的已知问题）。

* 仍存在的核查缺口：impressions/clicks/sessions 全 0 与 first\_deposit\_cnt 全 0 的根因（上游报表配置 / 事件改名）需在 Adjust 后台与同步日志进一步确认；币种口径无字段可查。