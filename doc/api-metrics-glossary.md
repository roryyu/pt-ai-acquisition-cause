# Adjust Datascape 指标术语表（中英对照 · 大模型提示词版）

> 来源：Adjust 官方文档《Datascape metrics》— https://help.adjust.com/en/article/datascape-metrics-glossary
> 整理日期：2026-09-08 · 原文全文抓取并翻译整理
> 用途：**可直接作为大模型提示词 / 系统知识库注入**，用于回答"指标含义、计算口径、API 查询参数"类问题；同时供人查阅。

---

## 〇、作为提示词的使用说明（先读）

本文件整理成「指标字典」结构，适合整体注入大模型上下文（System Prompt 或 RAG 文档）。注入时建议附带以下 4 条**口径硬约束**，避免模型答错：

1. **API Metric ID 是 Report Service API 的 `metrics` 参数取值**，不是 Datascape 界面显示名；用户问"怎么取某指标"时应返回 API Metric ID。
2. **ROAS / ROI 在 Datascape 界面以百分比显示（如 `40%`），API 返回小数（如 `0.4`）**——回答时注意区分数据来源。
3. **事件类指标的 ID 遵循 `{event_slug}_events` 模式**，slug 需通过 Adjust Events endpoint 获取（上游可能改名，不应猜测硬编码）。
4. **同期群指标 ID 中的 `{cohort_period}` 是占位符**，按所选同期群周期（0D–120D / 0W–52W / 0M–36M）替换，具体格式以 RS API 返回为准。
5. **含 `Ad Spend` 的公式结果取决于所选花费来源**（Adjust 归因口径 / Network 渠道 API 口径），三者数值可能不同。

**推荐的注入 Prompt 示例**：

```
你是一名移动应用增长分析师，掌握 Adjust 归因数据平台的全部指标口径。
请依据以下指标字典回答用户关于投放效果、成本、收入、留存、反欺诈的问题。
约束：
1) ROAS/ROI 在 Datascape 显示为百分比（40%），API 返回小数（0.4）；
2) 事件指标 ID 形如 {event_slug}_events，slug 以 Events endpoint 返回为准；
3) 同期群指标中的 {cohort_period} 为占位符，周期范围 0D-120D、0W-52W、0M-36M；
4) 广告花费类指标分三种口径：Attribution（Adjust 归因）/ Network（渠道 API）/ 总花费，回答时先确认口径；
5) 涉及具体指标时，同时给出中文含义、计算公式与 API Metric ID。
[在此粘贴下方指标字典全文]
```

---

## 一、文档背景

- **Datascape**：Adjust 的聚合数据视图，通过 Report Service API 可把多个数据源（Adjust KPI Service 归因数据、SKAdNetwork、Ad Spend 广告花费）拉到同一张报表。
- **API Metric ID**：调用 RS API 时放在 `metrics` 参数里的标识符（即下表第三列）。
- **event_slug**：RS API 用事件名（slug）而非 token 拉取事件数据；正确 slug 通过 Events endpoint 获取。
- **同期群周期支持**：天数 0D–120D、周数 0W–52W、月数 0M–36M；Datascape 界面可选周期有限，RS API 可查 0D–120D 任意单日。同期群指标分**累计（Cumulative）**与**非累计（Non-cumulative）**两类。

---

## 二、指标分类总览

| 分类 | 用途 | 代表指标 |
|---|---|---|
| 转化指标（Conversion） | 用户活动与转化率 | 安装/点击/展示/会话/ATT/LAT/再归因 |
| 同期群指标（Cohort） | 按安装/再归因群组的留存、收入、LTV、ROAS | 留存率/LTV/ROAS/付费率 |
| 广告花费指标（Ad Spend） | 成本核算与趋势 | Ad Spend/eCPI/eCPM/eCPC |
| 收入指标（Revenue） | 广告变现与用户消费 | 收入/ARPDAU/ROI/ROAS/RCR |
| SKAdNetwork 指标 | 苹果隐私框架回传数据 | 转化值/ROAS/RPU/eCPA |
| 订阅指标（Subscription） | 订阅生命周期 | 激活/续订/退款/订阅收入 |
| 反欺诈指标（Fraud） | 识别被拒绝的安装/再归因 | Rejected Installs 及原因分类 |
| 助攻指标（Assist） | 衡量助攻触点在归因中的角色 | Assisted Installs/Assisting 触点 |
| InSight 指标 | 增量测试（需 Growth Solution） | 增量收入/增量 ROAS |

---

## 三、转化指标（Conversion Metrics）

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| ATT - Authorized Users | 已授权 ATT（应用跟踪透明度）状态的用户数 | — | `att_status_authorized` |
| ATT - Not Determined Users | ATT 状态未确定的用户数 | — | `att_status_non_determined` |
| ATT - Denied Users | 拒绝 ATT 的用户数 | — | `att_status_denied` |
| ATT - Restricted Users | ATT 受限的用户数 | — | `att_status_restricted` |
| ATT Consent Rate | 展示 ATT 弹窗后同意授权的用户占比 | Authorized / (Denied + Authorized) | `att_consent_rate` |
| Avg. DAUs | 所选时间段内平均日活跃用户数 | 每日 DAU 之和 / 天数 | `daus` |
| Avg. MAUs | 平均月活跃用户数 | 每月 MAU 之和 / 月数 | `maus` |
| Avg. WAUs | 平均周活跃用户数 | 每周 WAU 之和 / 周数 | `waus` |
| Base Sessions | 基础会话数（**不含**安装与再归因会话） | — | `base_sessions` |
| Clicks | 点击数：SAN 渠道为渠道回传数，非 SAN 为 Adjust 直接测量数 | — | `clicks` |
| Clicks (Attribution) | 归因口径点击总数 | — | `attribution_clicks` |
| Clicks (Network) | 渠道上报的点击数 | — | `network_clicks` |
| Click Conversion Rate (CCR) | 点击转化率：平均多少次点击产生一次安装 | Installs / Clicks × 100 | `click_conversion_rate` |
| Click Through Rate (CTR) | 点击率：每次展示带来的点击占比 | Clicks / Impressions × 100 | `ctr` |
| Deattributions | 从首次归因来源移除以转给再归因来源的用户总数 | — | `deattributions` |
| Event | 每个周期内指定事件被触发的次数（非同期群口径） | — | `{event_slug}_events` |
| Total Events | 所有触发事件的总次数 | — | `events` |
| First Reinstalls | 首次重新安装数（需「卸载与重装」解决方案） | — | `first_reinstalls` |
| First Uninstalls | 首次卸载数（同上） | — | `first_uninstalls` |
| GDPR Forgets | 行使 GDPR 被遗忘权的用户数（Adjust 永久删除其个人历史数据但保留聚合数据） | — | `gdpr_forgets` |
| Impressions | 展示数：SAN 渠道回传 / 非 SAN 直接测量 | — | `impressions` |
| Impressions (Attribution) | 归因口径展示总数 | — | `attribution_impressions` |
| Impressions (Network) | 渠道上报的展示数 | — | `network_impressions` |
| Impression Conversion Rate (ICR) | 展示转化率：每次展示带来安装的比例 | Installs / Impressions × 100 | `impression_conversion_rate` |
| Installs | 应用安装数 | — | `installs` |
| Installs (Network) | 渠道上报的安装数 | — | `network_installs` |
| Installs Diff (Network) | 渠道与归因安装数之差的**绝对值** | \|Network - Attribution\| | `network_installs_diff` |
| Installs Diff (Network) (Signed) | 渠道与归因安装数的**带符号差**（归因安装更多时为负） | Network - Installs | `network_installs_diff_signed` |
| Installs per Mile (IPM) | 千次展示安装数 | 1000 × ICR | `installs_per_mile` |
| Limit Ad Tracking Installs | 开启限制广告追踪（LAT）设备的安装数 | — | `limit_ad_tracking_installs` |
| Limit Ad Tracking Rate | LAT 安装占总安装的比例 | LAT Installs / Installs | `limit_ad_tracking_install_rate` |
| Limit Ad Tracking Reattributions | LAT 设备的再归因数 | — | `limit_ad_tracking_reattributions` |
| Limit Ad Tracking Reattribution Rate | LAT 再归因占总再归因的比例 | — | `limit_ad_tracking_reattribution_rate` |
| Non-Organic Installs | 非自然（付费）安装数 | — | `non_organic_installs` |
| Organic Installs | 自然量安装数 | — | `organic_installs` |
| Reattribution | 已发生的再归因总数 | — | `reattributions` |
| Reattribution Reinstalls | 同时导致再归因的重新安装数 | — | `reattribution_reinstalls` |
| Redownload installs | 重新下载安装数（归属**新**归因来源，已计入 Installs） | — | `redownload_installs` |
| Redownload deinstalls | 重新下载前的**旧来源**上的重新下载安装数 | — | `redownload_deinstalls` |
| Redownload reattributions | 处理重新下载会话时发生但不构成安装的再归因数（计入 Reattributions） | — | `redownload_reattributions` |
| Redownload sessions | 应用收到的所有重新下载会话数（含重新下载安装与再归因） | — | `redownload_sessions` |
| Reinstalls | 重新安装总数（需「卸载与重装」解决方案） | — | `reinstalls` |
| Renewals | 续订数 | — | `renewals` |
| Sessions | 会话总数（含安装首会话、重装、再归因、再归因重装） | base_sessions + installs + reattributions | `sessions` |
| Uninstalls | 卸载数（需解决方案） | — | `uninstalls` |
| Uninstalls (Cohort) | 所选时间段内安装用户的卸载数（同期群口径） | — | `uninstall_cohort` |

---

## 四、同期群指标（Cohort Metrics）

> `N days` 为占位符，表示实际同期群周期；累计指标 = 自安装起截至 N 天的累积值，非累计指标 = 第 N 天的单日值。

### 4.1 累计（Cumulative）

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| N days Ad Impressions Total | 所选时间安装/再归因用户在同期群期内收到的**累计**广告展示数 | — | `ad_impressions_total_{cohort_period}` |
| N days Cost Per First-Time Paying User Total | 累计首充用户的平均广告花费 | Ad Spend / 首充用户总数 | `cost_per_paying_user_{cohort_period}` |
| N days Ad Impressions Total in Cohort | 同期群内累计广告展示数 | — | `ad_impressions_total_in_cohort_{cohort_period}` |
| N days Event (Conversions) | 安装/再归因后第 N 天完成指定事件的**用户数** | — | `{event_slug}_{cohort_period}_conversions_cohort` |
| N days Event (Events) | 安装后第 N 天完成的指定事件**次数** | — | `{event_slug}_{cohort_period}_events_cohort` |
| N days Event (Revenue) | 指定事件产生的应用内收入（SDK 上报或服务端 S2S 记录） | — | `{event_slug}_{cohort_period}_revenue_cohort` |
| N days Event (Converted User Size) | 到第 N 天完成事件**且**安装满 N 天的用户数 | — | `{event_slug}_{cohort_period}_converted_user_size_cohort` |
| N days Events per Conversion (Events) | 平均每次转化触发的事件次数 | Events / Conversions | `{event_slug}_{cohort_period}_events_per_conversion_cohort` |
| N days Events per Conversion (Revenue) | 平均每次转化产生的收入 | Revenue / Conversions | `{event_slug}_{cohort_period}_revenue_per_conversion_cohort` |
| N days Event (Event Rate) | 事件发生率：事件总次数 / 同期群规模 | Events / Cohort size | `{event_slug}_{cohort_period}_events_rate_cohort` |
| N days Event (Conversions Rate) | 事件转化率：首次触发事件的用户数 / 同期群规模 | Conversions / Cohort size | `{event_slug}_{cohort_period}_conversions_rate_cohort` |
| N days Revenue Total | 同期群期内累计应用内收入 | — | `revenue_total_{cohort_period}` |
| N days Revenue Total Per User | 人均累计应用内收入 | Revenue / Cohort size | `revenue_total_per_user_{cohort_period}` |
| N days Revenue Total Per Paying User | 付费用户人均累计收入 | Revenue / 首充用户数 | `revenue_total_per_paying_user_{cohort_period}` |
| N days Revenue Total In Cohort | 同期群内累计收入 | — | `revenue_total_in_cohort_{cohort_period}` |
| N days Revenue Events Total | 收入事件累计数 | — | `revenue_events_total_{cohort_period}` |
| N days Revenue Events Total in Cohort | 同期群内累计收入事件数（仅计满期用户） | — | `revenue_events_total_in_cohort_{cohort_period}` |
| N days Revenue Events Total per Paying User | 付费用户人均收入事件数 | 群内收入事件 / 首充用户 | `revenue_events_total_per_paying_user_{cohort_period}` |
| N days Ad Revenue Total | 累计广告变现收入 | — | `ad_revenue_total_{cohort_period}` |
| N days Ad Revenue Total Per User | 人均累计广告收入 | Ad Revenue / Cohort size | `ad_revenue_total_per_user_{cohort_period}` |
| N days Ad Revenue Total in Cohort | 同期群内广告收入（第 N 天满期用户） | — | `ad_revenue_total_in_cohort_{cohort_period}` |
| N days All Revenue Total | 全部累计收入（广告+内购，按 0 天群组口径） | Ad Revenue + Revenue | `all_revenue_total_{cohort_period}` |
| N days All Revenue Total Per User | 人均全部累计收入 | — | `all_revenue_total_per_user_{cohort_period}` |
| N days All Revenue Total in Cohort | 同期群内全部收入（仅满期用户） | — | `all_revenue_total_in_cohort_{cohort_period}` |
| N days LTV (Ad) All Users | 广告收入口径的用户生命周期价值（LTV） | 群内广告收入 / 群规模 | `lifetime_value_ad_{cohort_period}` |
| N days LTV (Ad) Paying Users | 广告收入口径的付费用户 LTV | — | `paying_user_lifetime_value_ad_{cohort_period}` |
| N days LTV (All) All Users | 全收入口径的用户 LTV | — | `lifetime_value_{cohort_period}` |
| N days ROAS (Ad Revenue) | 广告收入口径的广告支出回报率 | 广告收入 / Ad Spend | `roas_ad_{cohort_period}` |
| N days ROAS (All Revenue) | 全收入口径 ROAS | 全部收入 / Ad Spend | `roas_{cohort_period}` |
| N days ROAS (IAP Revenue) | 内购收入口径 ROAS | 应用内收入 / Ad Spend | `roas_iap_{cohort_period}` |
| N days LTV (All) Paying Users | 全收入口径的付费用户 LTV | — | `paying_user_lifetime_value_{cohort_period}` |
| N days LTV (IAP) All Users | 内购口径的用户 LTV | — | `lifetime_value_iap_{cohort_period}` |
| N days LTV (IAP) Paying Users | 内购口径的付费用户 LTV | — | `paying_user_lifetime_value_iap_{cohort_period}` |
| N days Total First-time Paying Users | 到 N 天为止完成首次内购的累计用户数 | — | `first_paying_users_total_{cohort_period}` |
| N days First-Time Paying Users Conversion Rate Total | 累计首充率 | 首充用户 / 群规模 | `cumulative_paying_users_conversion_rate_{cohort_period}` |
| N days First Reinstalls Total | 累计首次重装数 | — | `first_reinstalls_total_{cohort_period}` |
| N days Reinstalls Total | 累计重装数 | — | `reinstalls_total_{cohort_period}` |
| N days First Uninstalls Total | 累计首次卸载数 | — | `first_uninstalls_total_{cohort_period}` |
| N days Uninstalls Total | 累计卸载数 | — | `uninstalls_total_{cohort_period}` |
| N days GDPR Forget Users Total | 累计 GDPR 遗忘数 | — | `gdpr_forgets_total_{cohort_period}` |

### 4.2 非累计（Non-cumulative）

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| N days Ad Impressions | 同期群期内展示的广告数 | — | `ad_impressions_{cohort_period}` |
| N days Ad Revenue | 同期群期内的广告收入 | — | `ad_revenue_{cohort_period}` |
| N days Ad RPM | 千次展示广告收入 | (广告收入/广告展示) × 1000 | `ad_rpm_{cohort_period}` |
| N days All Revenue | 同期群期内的全部收入 | — | `all_revenue_{cohort_period}` |
| N days All Revenue Per User | 人均全部收入 | — | `all_revenue_per_user_{cohort_period}` |
| N days Cohort Size | 同期群规模：归因到给定来源且至少满 N 期的用户数 | — | `cohort_size_{cohort_period}` |
| N days Deattributions | 同期群期内的取消归因数 | — | `deattributions_{cohort_period}` |
| N days Cost per Event (Events) | 每次事件的广告花费 | Ad Spend / Events | `{event_slug}_{cohort_period}_events_cost_cohort` |
| N days Cost per Event (Conversions) | 每次转化的广告花费 | Ad Spend / Conversions | `{event_slug}_{cohort_period}_conversions_cost_cohort` |
| N days Deattributions Per User | 人均取消归因数 | — | `deattributions_per_user_{cohort_period}` |
| N days Event (Events per Period) | 同期群期内事件触发次数 | — | `{event_slug}_{cohort_period}_events_per_period` |
| N days Event (Revenue per Period) | 同期群期内事件产生的收入 | — | `{event_slug}_{cohort_period}_revenue_per_period` |
| N days First Reinstalls | 首次重装数 | — | `first_reinstalls_{cohort_period}` |
| N days First Uninstalls | 首次卸载数 | — | `first_uninstalls_{cohort_period}` |
| N days GDPR Forgets | GDPR 遗忘数 | — | `gdpr_forgets_{cohort_period}` |
| N days Non-Install Sessions | 非安装会话数 | — | `non_install_sessions_{cohort_period}` |
| N days First-Time Paying Users | 同期群期内完成首次内购的用户数 | — | `first_paying_users_{cohort_period}` |
| N days First-Time Paying Users Conversion Rate (Retained Users) | 首充率（按留存用户口径） | 首充 / 留存用户 | `first_time_paying_user_conversion_rate_{cohort_period}` |
| N days Paying User Size | 付费用户规模（满期且任一时点完成过内购） | — | `paying_user_size_{cohort_period}` |
| N days First-Time Paying Users Conversion Rate | 首充率（按群规模口径） | 首充 / 群规模 | `paying_user_conversion_rate_{cohort_period}` |
| N days Paying Users | 同期群期内完成内购的用户数 | — | `paying_users_{cohort_period}` |
| N days Paying Users Rate | 付费率 | 付费用户 / 群规模 | `paying_user_rate_{cohort_period}` |
| N days Reattributions | 同期群期内的再归因数 | — | `reattributions_{cohort_period}` |
| N days Reattributions per Deattribution | 再归因与取消归因之比 | 再归因 / 取消归因 | `reattributions_per_deattribution_{cohort_period}` |
| N days Reattributions Per User | 人均再归因数 | — | `reattributions_per_user_{cohort_period}` |
| N days Reinstalls | 重装数 | — | `reinstalls_{cohort_period}` |
| N days Retained Users | 留存用户数（满 N 期仍活跃） | — | `retained_users_{cohort_period}` |
| N days Retention Rate All Users | 留存率 | 留存用户 / 群规模 | `retention_rate_{cohort_period}` |
| N days Retention Rate Paying Users | 付费用户留存率 | 付费用户 / 留存用户 | `paying_users_retention_rate_{cohort_period}` |
| N days Revenue | 同期群期内的应用内收入 | — | `revenue_{cohort_period}` |
| N days Revenue Events | 收入事件数 | — | `revenue_events_{cohort_period}` |
| N days Revenue Events Per Active User | 活跃用户人均收入事件数 | — | `revenue_events_per_active_user_{cohort_period}` |
| N days Revenue Events Per Paying User | 付费用户人均收入事件数 | — | `revenue_events_per_paying_user_{cohort_period}` |
| N days Revenue Events Per User | 人均收入事件数 | — | `revenue_events_per_user_{cohort_period}` |
| N days Revenue Per Paying User | 付费用户人均收入 | Revenue / 付费用户 | `revenue_per_paying_user_{cohort_period}` |
| N days Revenue Per User | 人均收入 | Revenue / 群规模 | `revenue_per_user_{cohort_period}` |
| N days Sessions | 会话数 | — | `sessions_{cohort_period}` |
| N days Sessions Per User | 人均会话数 | — | `sessions_per_user_{cohort_period}` |
| N days Time Spent | 应用内停留总秒数 | — | `time_spent_{cohort_period}` |
| N days Time Spent Per Active User | 活跃用户人均停留秒数 | — | `time_spent_per_active_user_{cohort_period}` |
| N days Time Spent Per Session | 每次会话平均秒数 | 停留 / 非安装会话 | `time_spent_per_session_{cohort_period}` |
| N days Time Spent Per User | 人均停留秒数 | — | `time_spent_per_user_{cohort_period}` |
| N days Uninstalls | 卸载数 | — | `uninstalls_{cohort_period}` |

---

## 五、广告花费指标（Ad Spend Metrics）

> 含 `Ad Spend` 的公式随所选花费来源变化（归因口径 / Network 渠道口径）。`Ad Spend` 总花费 = click_cost + impression_cost + install_cost + event_cost。

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| Ad Spend | 广告总花费 | click + impression + install + event cost | `cost` |
| Ad Spend (Attribution) | 归因口径花费（仅用 Adjust 花费归因法取数） | 同上四项之和 | `adjust_cost` |
| Ad Spend (Network) | 渠道 API 上报的花费 | 同上四项之和 | `network_cost` |
| Ad Spend Diff (Network) | 归因与渠道花费之差的绝对值 | \|Attribution − Network\| | `network_cost_diff` |
| Click Cost | 点击成本 | — | `click_cost` |
| Clicks (Paid) | 有花费数据的点击数 | — | `paid_clicks` |
| eCPI (All Installs) | 全安装有效安装成本 | Ad Spend / Installs | `ecpi_all` |
| eCPI (Network) | 渠道口径有效安装成本 | Network Spend / Network Installs | `network_ecpi` |
| eCPI (Paid Installs) | 付费安装的有效成本 | Network Spend / Paid Installs | `ecpi` |
| eCPI (SKAdNetwork) | SKAN 安装的有效成本 | SKAN Spend / SKAN Installs | `skad_ecpi` |
| eCPM (Attribution) | 归因口径千次展示成本 | (Spend / Paid Impressions) × 1000 | `ecpm` |
| eCPM (Network) | 渠道口径千次展示成本 | — | `network_ecpm` |
| eCPC | 有效点击成本 | Ad Spend / Paid Clicks | `ecpc` |
| Event cost | 事件成本 | — | `event_cost` |
| Impression cost | 展示成本 | — | `impression_cost` |
| Impressions (Paid) | 有花费数据的展示数 | — | `paid_impressions` |
| Install Cost | 安装成本 | — | `install_cost` |
| Installs (Paid) | 有花费数据的安装数 | — | `paid_installs` |

---

## 六、收入指标（Revenue Metrics）

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| Ad Impressions | 向终端用户展示的广告数 | — | `ad_impressions` |
| Ad Revenue | 应用内广告变现收入 | — | `ad_revenue` |
| Ad Revenue (Cohort) | 所选时间安装/重装用户截至当前日期的累计广告收入 | — | `cohort_ad_revenue` |
| Ad RPM | 千次展示广告收入 | (广告收入 / 广告展示) × 1000 | `ad_rpm` |
| Revenue | 所选时间段内应用内收入（SDK 上报或 S2S 记录） | — | `revenue` |
| Revenue (Cohort) | 所选时间安装/重装用户截至当前日期的累计内购收入 | — | `cohort_revenue` |
| All Revenue | 应用全部收入（广告+内购） | Ad Revenue + Revenue | `all_revenue` |
| All Revenue (Cohort) | 累计全部收入 | Cohort Revenue + Cohort Ad Revenue | `cohort_all_revenue` |
| ARPDAU (All) | 日活跃用户人均收入（全口径） | 全部收入 / 区间内总 DAU | `arpdau` |
| ARPDAU (Ad) | 日活人均广告收入 | 广告收入 / 总 DAU | `arpdau_ad` |
| ARPDAU (IAP) | 日活人均内购收入 | 内购收入 / 总 DAU | `arpdau_iap` |
| Gross profit | 毛利 | 全部收入 − 广告花费 | `gross_profit` |
| Gross profit (Cohort) | 同期群毛利 | 同期群收入 − 广告花费 | `cohort_gross_profit` |
| Return On Investment (ROI) | 投资回报率 | 同期群毛利 / 广告花费 | `return_on_investment` |
| Revenue Events | 收入事件总次数 | — | `revenue_events` |
| Revenue To Cost Ratio (RCR) | 收入成本比 | 同期群收入 / 广告花费 | `revenue_to_cost` |
| ROAS (All Revenue) | 全收入口径广告支出回报率 | (群收入 + 群广告收入) / Ad Spend | `roas` |
| ROAS (Ad Revenue) | 广告收入口径 ROAS | 群广告收入 / Ad Spend | `roas_ad` |
| ROAS (IAP Revenue) | 内购收入口径 ROAS | 群内购收入 / Ad Spend | `roas_iap` |

---

## 七、SKAdNetwork 指标（SKAN）

> 与苹果 SKAdNetwork 归因框架相关；`Min/Avg/Max` 表示按转化值区间解包出的最小/估计/最大值。

| 指标（EN） | 定义（中文） | API Metric ID |
|---|---|---|
| Conversion Bit 1–6 (SKAN) | 触发对应转化事件的有效 SKAN 回传数（仅转化事件模型下有意义） | `conversion_1` … `conversion_6` |
| Conversion Value 0 (SKAN) | 转化值 = 0（仅安装、未触发任何映射条件）的回传数 | `conversion_value_0` |
| Conversion Value 1–63 (SKAN) | 对应转化值（1–63）的回传数 | `conversion_value_1` … `conversion_value_63` |
| Conversion Value greater than 0 (SKAN) | 转化值 > 0 的回传数 | `skad_conversion_value_gt_0` |
| Conversion Value Null | 转化值为空（SKAN3 / SKAN4 首次回传，苹果隐私框架隐藏后续数据）的回传数 | `skad_conversion_value_null` |
| Conversion Value Total (SKAN) | 所有转化值的加权总和（各转化值次数 × 转化值） | `conversion_value_total` |
| Conversion Value Null Rate (SKAN) | 空转化值回传占 SKAN 总转化之比 | `skad_conversion_value_null_rate` |
| Coarse conversion value（1st/2nd/3rd Postback） | 粗略转化值各档（null/none/low/medium/high）在三次回传中的计数 | `skad_coarse_conversion_values_{null,none,low,medium,high}_{0,1,2}` |
| Event eCR (SKAN) - Min/Avg/Max | 指定事件的有效转化率（最小/估计/最大） | `{event_slug}_skan_event_ecr_min/_est/_max` |
| Installs (SKAN) | 有效 SKAN 安装（redownload=false，归因签名校验通过） | `skad_installs` |
| Qualifiers (SKAN) | 与渠道有触点但未赢得最终 SKAN 归因的安装数（did-win:false） | `skad_qualifiers` |
| Invalid Payloads (SKAN) | 归因签名校验失败的回传数 | `invalid_payloads` |
| Reinstalls (SKAN) | 有效 SKAN 重装（redownload=true） | `skad_reinstalls` |
| Total conversions (SKAN) | SKAN 报告的总转化数（安装+重装） | `skad_total_installs` |
| Valid Conversions (SKAN) | 带有效转化值（非空）的回传数，含粗略值与精确值 0–63 | `valid_conversions` |
| eCPA (SKAN) | 指定事件的有效行动成本 | `{event_slug}_skan_ecpa` |
| Ad Spend (SKAN) | SKAN 广告花费（渠道 API 上报） | `network_ad_spend_skan` |
| ROAS (SKAN) - Min/Avg/Max | SKAN 口径广告支出回报率 | `skad_revenue_min_roas/_est_roas/_max_roas` |
| ROI (SKAN) - Min/Avg/Max | SKAN 口径投资回报率 | `skad_revenue_min_roi/_est_roi/_max_roi` |
| RPU - Ad Rev (SKAN) - Min/Avg/Max | SKAN 人均广告收入 | `skan_ad_rpu_min/_est/_max` |
| RPU - IAP (SKAN) - Min/Avg/Max | SKAN 人均内购收入 | `skan_iap_rpu_min/_est/_max` |
| Event RPU (SKAN) - Min/Avg/Max | 指定事件的人均收入 | `{event_slug}_skan_event_rpu_min/_est/_max` |
| Total RPU (SKAN) - Min/Avg/Max | SKAN 总人均收入 | `skan_total_rpu_min/_est/_max` |
| eCPI (SKAN) | SKAN 安装成本 | `skad_ecpi` |
| Ad Revenue (SKAN) - Min/Avg/Max | 按转化值区间解包的广告收入（最小/估计/最大） | `skad_ad_revenue_min/_est/_max` |
| In-App Revenue (SKAN) - Min/Avg/Max | 按转化值区间解包的内购收入 | `iap_revenue_revenue_min/_est/_max` |
| Total Revenue (SKAN) - Min/Avg/Max | 按转化值收入桶解包的全部收入 | `skan_total_revenue_min/_est/_max` |
| Event (SKAN) - Min/Max/Avg | 按事件计数条件从回传计算的事件数 | `{event_slug}_events_min/_max/_est` |
| Event Revenue (SKAN) - Min/Max/Avg | 事件收入（映射收入区间的下界/上界/中点，例：映射 $10–$20 → min $10、max $20、est $15） | `{event_slug}_revenue_min/_max/_est` |
| Total Revenue Events (SKAN) - Min/Avg/Max | 总收入事件数（含内购与广告收入事件） | `general revenue_events_min/_est/_max` |

**以下 SKAN 指标需向 Technical Account Manager 或 support@adjust.com 申请开通**：

| 指标（EN） | 定义（中文） | API Metric ID |
|---|---|---|
| Direct Total Installs (SKAN) | SKAdNetwork 直接上报的安装+重装数 | `skad_direct_total_installs` |
| Direct Installs (SKAN) | 直接从 SKAdNetwork 发送的有效安装回传（redownload=false） | `skad_direct_installs` |
| Direct Reinstalls (SKAN) | 直接从 SKAdNetwork 发送的有效重装回传（redownload=true） | `skad_direct_reinstalls` |
| Direct Invalid Payloads (SKAN) | 直接回传中归因签名校验失败的数量 | `skad_direct_invalid_payloads` |
| Direct Valid Conversions (SKAN) | 直接回传中带有效（非空）转化值的数量 | `skad_direct_valid_conversions` |
| Direct Conversion Value Null (SKAN) | 直接回传中转化值为空的数量 | `skad_direct_conversion_value_null` |
| Direct Conversion Value Greater Than 0 (SKAN) | 直接回传中转化值 > 0 的数量 | `skad_direct_conversion_value_gt_0` |
| Direct Conversion Bit 1–6 (SKAN) | 直接回传中触发对应转化事件的数量 | `skad_direct_conversion_1` … `skad_direct_conversion_6` |
| Direct Conversion Value 0–63 (SKAN) | 直接回传中对应转化值（0–63）的数量 | `skad_direct_conversion_value_0` … `skad_direct_conversion_value_63` |

---

## 八、订阅指标（Subscription Metrics）

### 8.1 事件与收入（Events & Revenue）

| 指标（EN） | 定义（中文） | API Metric ID |
|---|---|---|
| Activations | 用户激活订阅的次数 | `subscrevnt_activation_events` |
| Billing retry（仅 iOS） | 试用到期未取消且无扣款问题的次数 | `subscrevnt_billing_retry_events` |
| Cancellations | 用户取消订阅的次数 | `subscrevnt_cancellation_events` |
| Discounted offers | 通过折扣优惠激活订阅的次数 | `subscrevnt_discounted_offer_events` |
| Expirations | 订阅到期的次数 | `subscrevnt_expiration_events` |
| First conversion（旧版订阅） | 用户触发首次转化事件的次数 | `subscrevnt_first_conversion_events` |
| Grace period | 订阅进入宽限期的次数 | `subscrevnt_grace_period_events` |
| On hold（仅 Android） | 订阅进入账户冻结的次数 | `subscrevnt_on_hold_events` |
| Paused（仅 Android） | 订阅暂停的次数 | `subscrevnt_paused_events` |
| Price accepted | 用户确认订阅价格变更的次数 | `subscrevnt_price_accepted_events` |
| Price declined（仅 iOS） | 用户拒绝订阅价格变更的次数 | `subscrevnt_price_declined_events` |
| Reactivations | 用户重新激活订阅的次数 | `subscrevnt_reactivation_events` |
| Renewals | 用户续订的次数 | `subscrevnt_renewal_events` |
| Renewals from billing retry | 扣款问题解决后成功续订的次数 | `subscrevnt_renewal_from_billing_retry_events` |
| Refunds（仅 iOS） | 订阅交易被退款的次数 | `subscrevnt_refund_events` |
| Revoked | 用户到期前撤销订阅的次数 | `subscrevnt_revoked_events` |
| Trials started | 用户开始试用的次数 | `subscrevnt_trial_started_events` |
| Activation revenue | 首次激活订阅产生的收入 | `subscrevnt_activation_revenue` |
| Discounted offer revenue | 折扣价购买新订阅产生的收入 | `subscrevnt_discounted_offer_revenue` |
| Reactivation revenue | 取消后重新激活订阅产生的收入 | `subscrevnt_reactivation_revenue` |
| Refund revenue（仅 iOS） | 退款交易的收入 | `subscrevnt_refund_revenue` |
| Renewal revenue | 成功续订产生的收入 | `subscrevnt_renewal_revenue` |
| Renewal from billing retry revenue | 扣款恢复后成功续订的收入 | `subscrevnt_renewal_from_billing_retry_revenue` |
| Subscription revenue | 全部订阅事件的总收入 | `subscrevnt_revenue` |
| Unknown revenue | 未定义事件的收入 | `subscrevnt_unknown_revenue` |

### 8.2 订阅累计同期群指标

| 指标（EN） | 定义（中文） | API Metric ID |
|---|---|---|
| N days {事件} Total（激活/扣款重试/取消/折扣/到期/首次转化/宽限/冻结/暂停/接受价格/拒绝价格/重激活/退款/续订/续订恢复/撤销/试用开始） | 同期群期内各订阅事件累计次数 | `subscription_{event}_events_total_{cohort_period}` |
| N days Revenue total（activations / discounted offers / reactivations / refunds / renewals / retries / other） | 同期群期内各类型累计收入 | `subscription_{type}_revenue_total_{cohort_period}` |
| N days Subscription Revenue Total | 同期群期内的累计订阅总收入（七类收入之和） | `subscription_revenue_total_{cohort_period}` |
| N days Subscription Revenue Total in Cohort | 同期群内归属用户的订阅相关总收入 | `subscription_subscription_revenue_total_in_cohort_{cohort_period}` |
| N days Conversion rates | 订阅状态转化率：从事件 A（安装/试用/折扣/激活/续订）到事件 B 的转化 | `subscription_{event_from}_to_{event_to}_rate_{cohort_period}`（如 install→trial、trial→renewal、renewal→cancellation） |

### 8.3 订阅非累计同期群指标

| 指标（EN） | 定义（中文） | API Metric ID |
|---|---|---|
| N days {事件}（激活/扣款重试/取消/折扣/到期/首次转化/宽限/冻结/暂停/接受价格/拒绝价格/重激活/退款/续订/续订恢复/撤销/试用开始） | 安装或再归因后第 N 天各订阅事件发生次数 | `subscription_{event}_events_{cohort_period}` |
| N days {收入类型}（activation / discounted offer / reactivation / refund / renewal / renewal from billing retry / unknown） | 安装或再归因后第 N 天各类型收入 | `subscription_{type}_revenue_{cohort_period}` |
| N days Subscription Revenue | 同期群期内全部订阅事件收入 | 七类收入之和 | `subscription_revenue_{cohort_period}` |
| N days Subscription ROAS | 订阅 ROAS | 同期群收入 / 花费 | `subscription_roas_{cohort_period}` |

---

## 九、反欺诈指标（Fraud Metrics）

> 帮助监控被拒绝的安装/再归因等 KPI；与 Adjust 反欺诈方案配套。

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| Rejected Installs | Adjust 识别并判定为欺诈的安装总数 | — | `rejected_installs` |
| Rejected Install Rate | 安装被判定为欺诈的比例（Total 行排除 Organic 与 Untrusted Devices） | (rejected − organic rejected) / (installs − organic − untrusted + rejected − organic rejected) | `rejected_install_rate` |
| Rejected Installs Anonymous IP (+Rate) | 因匿名 IP 被拒的安装数（及其占比） | 拒绝数 / (installs + rejected) | `rejected_installs_anon_ip` / `rejected_install_anon_ip_rate` |
| Rejected Installs Click Injection (+Rate) | 因下载与安装之间伪造点击（点击注入）被拒的安装数（及其占比） | 同上 | `rejected_installs_click_injection` / `rejected_install_click_injection_rate` |
| Rejected Installs Distribution Outlier (+Rate) | 因超出分布建模阈值被拒的安装数（及其占比） | 同上 | `rejected_installs_distribution_outlier` / `rejected_install_distribution_outlier_rate` |
| Rejected Installs Malformed Advertising ID (+Rate) | 因广告 ID 格式异常被拒的安装数（及其占比） | — | `rejected_install_malformed_advertising_id` / `rejected_install_malformed_advertising_id_rate` |
| Rejected Installs SDK Signature | 因 SDK 签名无效或缺失被拒的安装数 | — | `rejected_installs_invalid_signature` |
| Invalid Signature Rejected Install Rate | 因签名无效被拒的安装占比 | invalid / (installs + rejected) | `rejected_install_invalid_signature_rate` |
| Rejected Installs Too Many Engagements (+Rate) | 因归因窗口内触点过多被拒的安装数（及其占比） | 同上 | `rejected_installs_too_many_engagements` / `rejected_install_too_many_engagements_rate` |
| Rejected Reattribution (+Rate) | 被判定为欺诈的再归因数（及其占比） | 拒绝数 / (再归因 + 拒绝数) | `rejected_reattributions` / `rejected_reattribution_rate` |
| Rejected Reattributions Anonymous IP (+Rate) | 因匿名 IP 被拒的再归因数（及其占比） | 同上 | `rejected_reattributions_anon_ip` / `rejected_reattribution_anon_ip_rate` |
| Rejected Reattributions Click Injection (+Rate) | 因点击注入被拒的再归因数（及其占比） | 同上 | `rejected_reattributions_click_injection` / `rejected_reattributions_click_injection_rate` |
| Rejected Reattributions Distribution Outlier (+Rate) | 因分布异常被拒的再归因数（及其占比） | 同上 | `rejected_reattributions_distribution_outlier` / `rejected_reattribution_distribution_outlier_rate` |
| Rejected Reattributions Too Many Engagements (+Rate) | 因再归因窗口内触点过多被拒的再归因数（及其占比） | 同上 | `rejected_reattributions_too_many_engagements` / `rejected_reattribution_too_many_engagements_rate` |

---

## 十、助攻指标（Assist Metrics）

> 衡量不同触点（点击/展示）在归因中"助攻"安装的作用：进入归因候选但未被最终选中的触点。

| 指标（EN） | 定义（中文） | API Metric ID |
|---|---|---|
| Assisted Installs | 符合归因条件但未被选中的安装数（自然用户无 Adjust 链接触点，不计为助攻） | `assisted_installs` |
| Assisting Engagements | 被考虑但未赢得归因的全部触点（点击或展示，须在归因窗口内） | `qualifiers` |
| Assisting Impressions | 被考虑但未赢得归因的展示触点 | `impression_based_qualifiers` |
| Assisting Clicks | 被考虑但未赢得归因的点击触点 | `click_based_qualifiers` |
| Average Engagements per Assisted Install | 每次助攻安装的平均触点数 | `qualifiers_per_assisted_installs` |
| Average Impressions per Assisted Install | 每次助攻安装的平均展示数 | `impression_based_qualifiers_per_assisted_installs` |
| Average Clicks per Assisted Install | 每次助攻安装的平均点击数 | `click_based_qualifiers_per_assisted_installs` |
| Assisting Clicks for Reattributions | 被考虑但未赢得再归因的点击触点 | `click_based_reattribution_qualifiers` |
| Assisting Impressions for Reattributions | 被考虑但未赢得再归因的展示触点 | `impression_based_reattribution_qualifiers` |
| Assisting Engagements for Reattributions | 被考虑但未赢得再归因的全部触点（须在再归因窗口内） | `reattribution_qualifiers` |
| Assisted Reattributions | 符合再归因条件但未被选中的安装数 | `assisted_reattributions` |
| Non-Assisted Installs | 归因触点前无合格触点的安装数 | `non_assisted_installs` |

---

## 十一、增量测试指标（InSight Metrics）

> InSight 是 Adjust 的 Growth Solution（需联系 sales@adjust.com 开通），用于增量（incrementality）测试。

| 指标（EN） | 定义（中文） | 公式 | API Metric ID |
|---|---|---|---|
| Average revenue per event | 所选事件的平均收入（所选时间安装用户） | 事件总收入 / 事件触发次数 | `average_revenue_per_event` |
| Incremental revenue | 相对对照组产生的额外收入 | (实际增量值 − 均值增量值) × 每事件平均收入 | `incremental_revenue` |
| Incremental ROAS | 增量测试口径的 ROAS（仅内购收入） | — | `incremental_roas` |

---

## 十二、指标 ID 命名模式速查（供 LLM 推导规则）

未在表中列出的指标 ID 可按以下模式推导（回答时仍建议以官方返回为准）：

| 模式 | 说明 | 示例 |
|---|---|---|
| `{event_slug}_events` | 非同期群事件计数 | `register_events`、`firstdeposit_events` |
| `{event_slug}_{period}_events_cohort` | 事件同期群计数 | 事件 + 周期 + 口径后缀 |
| `{event_slug}_{period}_conversions_cohort` | 事件同期群转化人数 | 同上 |
| `{event_slug}_{period}_revenue_cohort` | 事件同期群收入 | 同上 |
| `{event_slug}_{period}_events_rate_cohort` / `_conversions_rate_cohort` | 事件率 / 转化率 | 同上 |
| `{event_slug}_{period}_events_cost_cohort` / `_conversions_cost_cohort` | 单事件 / 单转化成本 | 同上 |
| `{event_slug}_{period}_events_per_period` / `_revenue_per_period` | 单期事件数 / 单期事件收入 | 同上 |
| `{event_slug}_skan_event_ecr_min/_est/_max` | SKAN 事件有效转化率 | 同上 |
| `{event_slug}_skan_event_rpu_min/_est/_max` | SKAN 事件人均收入 | 同上 |
| `{event_slug}_skan_ecpa` | SKAN 事件有效行动成本 | 同上 |
| `{event_slug}_revenue_min/_est/_max` | SKAN 事件收入区间解包 | 同上 |
| `revenue_total_*` / `all_revenue_total_*` / `ad_revenue_total_*` / `cohort_size_*` / `retention_rate_*` | 收入/群规模/留存 累计与非累计 | `revenue_total_7d` 风格 |
| `cost_per_paying_user_*` / `first_paying_users_*` / `paying_user_conversion_rate_*` | 首充与付费类 | 同上 |
| `roas_*` / `roas_ad_*` / `roas_iap_*` / `lifetime_value_*` / `paying_user_lifetime_value_*` | 回收与 LTV 类 | 同上 |
| `subscription_{event}_events_total_{period}` / `subscription_{type}_revenue_{period}` | 订阅事件/收入（累计加 `_total`） | 同上 |
| `subscription_{from}_to_{to}_rate_{period}` | 订阅转化率 | `subscription_install_to_trial_rate_*` 风格 |
| `skad_*` / `skad_direct_*` / `skan_*` | SKAN 指标前缀 | `skad_installs`、`skan_ad_rpu_est` |
| `rejected_install(s)_*` / `rejected_reattribution(s)_*` | 反欺诈指标前缀（`_rate` 为占比） | `rejected_installs_click_injection` |
| `att_*`、`limit_ad_tracking_*` | ATT / LAT 指标前缀 | `att_consent_rate` |

> 注意：`{cohort_period}` 的具体书写格式（如 `7d` / `30d` / `1w` / `3m`）以 Adjust RS API 实际返回为准，本表不臆造。

---

## 十三、给 LLM 的问答映射建议（用户问题 → 指标）

| 用户问什么 | 应优先映射到 | 补充提示 |
|---|---|---|
| 安装成本 / 买量贵不贵 | eCPI（`ecpi`/`ecpi_all`/`network_ecpi`） | 区分全安装/付费安装/渠道口径 |
| 展示与点击效率 | CTR（`ctr`）、eCPM（`ecpm`）、IPM | 前置漏斗，注意部分渠道不回传 |
| 花了多少钱 | Ad Spend（`cost`/`adjust_cost`/`network_cost`） | 三口径并存，先确认数据来源 |
| 买量回本没有 | ROAS / ROI（`roas`/`roas_iap`/`return_on_investment`） | API 返回小数，界面显示百分比 |
| 用户质量 / 值多少钱 | LTV（`lifetime_value_*`）、ARPDAU（`arpdau`） | 常配同期群周期看趋势 |
| 留存好不好 | Retention Rate（`retention_rate_*`） | 同期群指标，注意累计/非累计 |
| 付费用户占比 | Paying Users Rate、首充率（`paying_user_conversion_rate_*`） | 区分首充/全量付费 |
| 付费转化链路 | 自定义事件（`{event_slug}_events` 及 cohort 系列） | slug 需 Events endpoint 获取 |
| 订阅业务健康度 | 订阅事件与收入（`subscrevnt_*`、`subscription_*`） | 注意 iOS/Android 平台专属事件 |
| 有没有刷量/假量 | Rejected Installs（`rejected_installs` 及原因分类） | Total 口径排除 Organic 与 Untrusted Devices |
| iOS 隐私环境下的回收 | SKAN 系列（`skad_*`/`skan_*`） | Min/Avg/Max 为区间解包，部分需申请开通 |
| 助攻触点价值 | Assist 系列（`assisted_installs`/`qualifiers`） | 区分点击助攻/展示助攻 |

---

## 十四、流量投放专家视角：指标监控分层（怎么用这套指标）

> 专家原则：**日看量价、周看质量、月看价值**。约 280 个指标不是天天看的——高频盯的只有 **40 个左右**，其余留给专项诊断。
> 分层依据两个维度：**决策频率**（多久做一次投放/预算/策略决策）与**数据成熟度**（回传延迟、T+1 修正、同期群未成熟前不可下结论）。

### 14.1 分层总览

| 频率 | 回答什么问题 | 核心逻辑 | 聚焦指标数 |
|---|---|---|---|
| 每日 | 今天花了多少、买了多少、什么价、有没有异常 | 量 / 价 / 效率 / 即时回收 / 异常闸门，防跑偏 | ~18 |
| 每周 | 买来的用户质量如何、转化链是否健康 | 留存 / 付费 / 早期回收，等数据稳定后评估质量 | ~15 |
| 每月 / 每季 | 长期价值、利润、策略级结论 | LTV / ROI / 收入结构 / 隐私环境，支撑预算与策略 | ~10 |
| 专项按需 | 出问题时查根因 | 细分诊断类指标，问题驱动 | 其余全部 |

### 14.2 每日监控看板（Daily Watch）

| 类别 | 指标（中文） | API Metric ID | 为什么每天看 |
|---|---|---|---|
| 花费 | Ad Spend（总 / 归因 / 渠道） | `cost` / `adjust_cost` / `network_cost` | 预算是日级控制变量，超支必须当天发现 |
| 花费 | 点击 / 展示 / 安装 / 事件成本 | `click_cost` / `impression_cost` / `install_cost` / `event_cost` | 成本结构异常当天定位 |
| 量 | 展示 / 点击 / 安装 | `impressions` / `clicks` / `installs` | 起量 / 掉量的第一信号 |
| 量 | 自然安装 / 非自然安装 | `organic_installs` / `non_organic_installs` | 区分付费拉动与自然波动 |
| 价 | eCPI（全安装 / 付费 / 渠道） | `ecpi_all` / `ecpi` / `network_ecpi` | 当日获客成本，与目标 CPI 对账 |
| 价 | eCPM（归因 / 渠道）、eCPC | `ecpm` / `network_ecpm` / `ecpc` | 竞价成本水位 |
| 效率 | CTR / CCR / ICR / IPM | `ctr` / `click_conversion_rate` / `impression_conversion_rate` / `installs_per_mile` | 素材与流量质量的即时反馈 |
| 活跃 | 会话 / DAU | `sessions` / `daus` | 大盘活跃水位 |
| 转化 | 核心自定义事件（注册 / 首存 / 复存） | `{event_slug}_events` | 核心漏斗日级健康度 |
| 回收 | Revenue (Cohort) / ROAS（全口径） | `cohort_revenue` / `roas` | 即时回收快照（注意回传延迟，看趋势不看绝对值） |
| 异常 | Rejected Install Rate | `rejected_install_rate` | 刷量风险的日级闸门 |
| 对账 | Installs Diff (Network) | `network_installs_diff` | 渠道与归因差异是匹配/配置问题的预警信号 |
| 合规 | LAT Rate | `limit_ad_tracking_install_rate` | iOS 数据可归因性水位 |

### 14.3 周度重点关注（Weekly Review）

| 类别 | 指标（中文） | API Metric ID | 为什么周度看 |
|---|---|---|---|
| 留存 | 留存率 D1 / D3 / D7 | `retention_rate_{period}` | 数据稳定后看质量；D7 是第一个"成色"关口 |
| 付费 | 首充率 / 付费率 | `paying_user_conversion_rate` / `paying_user_rate` | 变现潜力判断 |
| 回收 | 早期 LTV（D7 / D14） | `lifetime_value_{period}` | 回本周期初判 |
| 回收 | 早期 ROAS（内购 / 全收入） | `roas_iap_{period}` / `roas_{period}` | 周级回本跟踪 |
| 收入 | ARPDAU（全 / 内购 / 广告） | `arpdau` / `arpdau_iap` / `arpdau_ad` | 单位活跃价值 |
| 事件转化 | 注册→首存等事件同期群转化 | `{event_slug}_{period}_conversions_cohort` | 核心漏斗周级转化率 |
| 成本 | 单转化 / 单事件成本 | `{event_slug}_{period}_conversions_cost_cohort` / `_events_cost_cohort` | 质量与成本联看 |
| 粘性 | 人均会话 / 人均时长 | `sessions_per_user` / `time_spent_per_user` | 产品粘性信号 |
| 召回 | 再归因 / 重装 | `reattributions` / `reinstalls` | 拉回与召回策略效果 |
| 欺诈 | 拒绝安装按原因分类趋势 | `rejected_install_{reason}_rate` | 刷量手段是否变化 |
| 授权 | ATT Consent Rate | `att_consent_rate` | iOS 归因环境健康度 |
| 订阅（如适用） | 激活 / 续订 / 取消 | `subscrevnt_activation_events` 等 | 订阅业务周级健康 |

### 14.4 月度 / 季度重点关注（Monthly / Quarterly）

| 类别 | 指标（中文） | API Metric ID | 为什么月度看 |
|---|---|---|---|
| 长期价值 | LTV（D30 / D60 / D90） | `lifetime_value_{period}` | 决定买量预算上限 |
| 利润 | ROI / 毛利 | `return_on_investment` / `gross_profit` | 真正的"赚钱"结论 |
| 回收 | 长期 ROAS（D30+） | `roas_{period}` / `roas_iap_{period}` | 回本验证 |
| 留存 | 长期留存（D30） | `retention_rate_{period}` | 产品长线健康 |
| 收入结构 | All Revenue = IAP + Ad | `all_revenue` / `revenue` / `ad_revenue` | 变现结构变化 |
| 付费 | 累计首充用户 / 累计首充率 | `first_paying_users_total` / `cumulative_paying_users_conversion_rate` | 大盘付费渗透 |
| 规模 | MAU | `maus` | 月度规模 |
| 收入比 | RCR（收入成本比） | `revenue_to_cost` | 回收效率趋势 |
| 隐私环境 | SKAN ROAS / Valid Conversions / 空值率 | `skad_revenue_est_roas` / `valid_conversions` / `skad_conversion_value_null_rate` | iOS 隐私环境下的回收评估 |
| 订阅（如适用） | 订阅收入 / 订阅 ROAS / 订阅转化率 | `subscription_revenue` / `subscription_roas_{period}` / `subscription_{from}_to_{to}_rate_{period}` | 订阅制核心经营指标 |
| 增量测试 | Incremental ROAS / Revenue | `incremental_roas` / `incremental_revenue` | 营销真实增量（按测试周期评估） |
| 合规 | GDPR Forgets | `gdpr_forgets` | 合规审计 |

### 14.5 专项 / 按需（On-demand，不常看）

| 场景 | 指标（中文） | API Metric ID | 触发时机 |
|---|---|---|---|
| 重装行为 | Redownload 细分（安装 / 旧来源 / 再归因 / 会话） | `redownload_installs` / `redownload_deinstalls` / `redownload_reattributions` / `redownload_sessions` | 重装占比异常或拉回策略复盘 |
| 反欺诈深查 | 按原因拒绝安装 / 再归因细分 | `rejected_installs_click_injection` / `_distribution_outlier` / `_anon_ip` / `_too_many_engagements` 等 | 欺诈率突增时定位手段 |
| 归因稳定性 | Deattributions、LAT 再归因细分 | `deattributions` / `limit_ad_tracking_reattributions` 等 | 归因波动或渠道对账异常 |
| iOS 调优 | SKAN 全部细分（Coarse conversion value、事件收入区间） | `skad_coarse_conversion_values_*` / `{event_slug}_revenue_min/_est/_max` 等 | 调整 iOS 转化值映射时 |
| SKAN 直连 | Direct* 系列（需申请开通） | `skad_direct_*` | 苹果直连数据专项核对 |
| 订阅深诊 | 宽限 / 冻结 / 暂停 / 扣款重试 / 退款等 | `subscrevnt_grace_period_events` / `subscrevnt_on_hold_events` 等 | 订阅漏斗专项诊断 |
| 助攻链路 | Assist 系列 | `assisted_installs` / `qualifiers` / `click_based_qualifiers` 等 | 季度 / 大型活动后的链路评估 |

### 14.6 看板的减法原则（280 → 40 → 10）

把指标按"**是否影响当日行动**"过滤：每日看板 15–18 个、周报 ~15 个、月报 ~10 个，其余进"诊断箱"（出问题时才打开）。

> **如果只能看 10 个指标**：Ad Spend、Installs、eCPI、CTR、D1 留存、首充率、D7 ROAS、ARPDAU、LTV（D30）、Rejected Install Rate。
> 这 10 个覆盖了"花钱 → 买量 → 价格 → 效率 → 质量 → 变现 → 回收 → 长期价值 → 风险"的完整链路，任何单一指标异常都能顺着链路定位到具体原因。

### 14.7 专家提醒（口径陷阱）

1. **回传延迟与 T+1 修正**：ROAS / 同期群数据未成熟（immature）前别下结论；日更看趋势方向，周更才看结论。
2. **欺诈率分母**：Rejected Install Rate 的 Total 口径排除 Organic 与 Untrusted Devices，跨表对比时注意分母不一致。
3. **SAN vs 非 SAN**：clicks / impressions 在 SAN 渠道来自渠道回传、非 SAN 来自 Adjust 自测，跨渠道直接对比会失真。
4. **Installs Diff 是健康信号**：渠道与归因持续偏差时，先查归因参数、App 链接、匹配窗口，而不是直接采信某一侧。
5. **LAT 升高 = iOS 可归因数据变少**：决策时注意样本代表性，配合 SKAN 交叉验证。
6. **SKAN 的 Min/Avg/Max 是区间解包，不是真实值**；Conversion Value Null 率高说明隐私裁剪严重，回收数据要打折看。
7. **订阅指标平台专属**：Billing retry / Refund 仅 iOS，On hold / Paused 仅 Android，汇总对比时别混口径。
8. **eCPI 有多个口径**：全安装（ecpi_all）与付费安装（ecpi）差异巨大时，说明自然/免费量占比高，先分清再解读。

---

*整理说明：本文件基于 Adjust 官方文档英文原文逐项翻译整理；公式与 API Metric ID 均照原文保留。部分平台专属指标（如仅 iOS / 仅 Android）已在定义中标注。SKAN 中需申请开通的指标已单独标注。*
