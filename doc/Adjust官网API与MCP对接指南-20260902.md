# Adjust API 与 MCP 对接指南

> 整理日期：2026-09-02
> 资料来源：Adjust 帮助中心（help.adjust.com）与 Adjust Developer Hub（dev.adjust.com），经内置浏览器实地探索验证
> 适用对象：需要将 Adjust 数据接入自有系统 / AI 工具流的团队

---

## 〇、对接路线总览

Adjust 官方提供两条数据对接路线：

| 路线 | 定位 | 认证方式 | 数据范围 | 开通门槛 |
|---|---|---|---|---|
| **API 直连**（Developer Hub） | 程序化取数/写数，接 BI、数据仓库、自动化脚本 | API 识别码（Bearer Token） | 聚合 + 原始数据（部分 API） | 无，账号内自助获取 Token |
| **Adjust MCP**（Model Context Protocol） | 让 AI 客户端（Claude/Cursor/Codex/n8n 等）用自然语言查询 Adjust 数据 | OAuth | **仅聚合数据** | 抢先体验，需联系 sales@adjust.com 开通 |

文档入口：
- 开发者中心：`https://dev.adjust.com/zh`（分 SDK / API 两区）
- 帮助中心：`https://help.adjust.com/zh`（分营销人员 / 开发者 / 合作伙伴三区）

## 一、API 直连

### 1.1 全部 8 类 API

| API | 用途 | 文档 |
|---|---|---|
| **报告服务 API（RS API）** | 拉取聚合数据（KPI/同期群/SKAN/广告支出），取数主力 | `dev.adjust.com/zh/api/rs-api` |
| 合作伙伴广告支出 API | 渠道方**向 Adjust 写入**广告花费（解决 cost 缺失的关键） | `dev.adjust.com/zh/api/ad-spend-api` |
| 屏蔽名单 API | 拦截欺诈来源/过期跟踪链接的流量 | `dev.adjust.com/zh/api/blocklist-api` |
| 推广活动 API | 管理链接、子链接与合作伙伴信息 | `dev.adjust.com/zh/api/campaign-api` |
| Adjust 自动化 API | 程序化批量创建、更新、管理应用 | `dev.adjust.com/zh/api/app-automation-api` |
| 设备 API | 查询设备信息、清除测试设备历史 | `dev.adjust.com/zh/api/device-api` |
| S2S API | 不改客户端代码，服务器直连接入 Adjust | `dev.adjust.com/zh/api/s2s-api` |
| TrueLink API（深度链接生成器） | 单个/批量创建应用定制深度链接 | `dev.adjust.com/zh/api/deep-link-generator-api` |

### 1.2 报告服务 API：认证

1. **获取 API 识别码**：Adjust 控制面板 → 左下角设置 → 账户设置 → 个人档案 → `API 识别码`（本账号已确认可见，位于"用户详细信息"中，可一键复制）；
2. **调用方式**：HTTP Header 中携带 Bearer Token：
   ```
   Authorization: Bearer <adjust_api_token>
   ```
3. 识别码可随时重置（重置后旧码立即失效）；若配置了 SSO 则面板中看不到识别码，需联系 support@adjust.com。

### 1.3 报告服务 API：四种响应格式终端

Base URL：`https://automate.adjust.com/reports-service/`

| 终端 | 路径 | 说明 |
|---|---|---|
| CSV 报告 | `/csv_report` | 通用 CSV 格式（含 UTF-8 BOM；`readable_names=true` 时表头为账号语言的本地化名称，中文账号实测如「日 (日期),渠道 (归因),安装,点击」） |
| JSON 报告 | `/report` | JSON 格式，返回 `{rows, totals, data_warnings}` 结构（实测：`/json_report` 为 404） |
| **Parquet 报告** | `/parquet_report` | 官方推荐：**大规模报表首选**，体积更小、处理更高效 |
| 透视报告 | `/pivot_report` | JSON，按维度细分总计；**必传 `index=<维度>` 参数**，返回以该维度值为键的嵌套结构 |

每类终端覆盖四组数据集：**KPI 服务指标、KPI 服务同期群、SKAdNetwork、广告支出**。

辅助终端：
- **过滤器数据终端**（`/filters-data`）：程序化搜索可用指标与维度；
- **事件终端**（`/events`）：返回机器生成的事件 slug，供 CSV 报告使用（长期运行的报告建议用 slug 而非人类可读名称，避免上游改名破坏一致性）。

### 1.4 CSV 终端调用细节（实测文档核对）

**终端**：
```
GET https://automate.adjust.com/reports-service/csv_report
```

**官方 cURL 示例**：
```bash
curl \
  --header 'Authorization: Bearer <adjust_api_token>' \
  --location --request GET 'https://automate.adjust.com/reports-service/csv_report?ad_spend_mode=network&app_token__in={app_token1},{app_token2}&date_period=2021-05-01:2021-05-02&dimensions=app,partner_name,campaign,campaign_id_network,campaign_network&metrics=installs,network_cost'
```

**成功响应示例**：
```csv
app,partner_name,campaign,campaign_id_network,campaign_network,installs,network_cost
App Name,AppLovin,Campaign Name (Campaign ID),Campaign ID,Campaign Network,64,1000
```

**核心必选参数**（带 `*`）：

| 参数 | 说明 | 示例 |
|---|---|---|
| `dimensions`* | 分组维度，逗号分隔 | `dimensions=app,os_name,week,campaign_id_network` |
| `metrics`* | KPI 指标，逗号分隔，至少 1 个 | `metrics=cost,installs,ecpi_network` |
| `date_period`* | 日期范围，三种格式 | 逻辑日期 `today` / `yesterday` / `this_week` / `last_week` / `this_month` / `last_month`；绝对日期 `2020-12-31:2021-01-01`；相对日期 `-10d:-3d` |

**常用可选参数**：

| 参数 | 说明 |
|---|---|
| `cohort_maturity=immature/mature` | 同期群是否含未成熟数据 |
| `readable_names=true` | 列标题返回人类可读名（默认为 slug） |
| `utc_offset=+08:00` / `timezone_id` | 报告时区 |
| `attribution_types=click,engaged_ad` | 归因交互类型 |
| `attribution_source=first/dynamic` | 活动归因到首装来源还是动态来源（默认 dynamic） |
| `reattributed=all/true/false` | 再归因用户过滤 |
| `ad_spend_mode=adjust/network/mixed` | 广告支出计算口径 |
| `os_names=ios,android` | 操作系统过滤 |
| `sandbox=true/false` | 沙箱/真实流量（默认 false） |
| `sort=-clicks,installs` | 排序，`-` 前缀为降序 |
| `period_over_period=previous_week` | 环比周期 |
| `currency=USD` | 金额指标换算币种 |
| `format_dates=false` | 日期输出 ISO 格式 |
| `hour__between=-10h:-0h` | 小时区间过滤 |

**维度过滤操作符**（适用于任意 dimension/metric）：

- 维度值：`__in`（精准匹配）、`__not_in`、`__contains`（子串，不区分大小写）、`__exclude`、`__starts_with`、`__not_starts_with`、`__ends_with`、`__not_ends_with`
- 指标值：`__lt`、`__lte`、`__gt`、`__gte`、`__eq`、`__ne`
- 例：`country_code__in=ph,th`、`installs__gte=1000`

**可用维度**（节选）：`hour/day/week/month/year/quarter`（时间）、`os_name`、`device_type`、`platform`、`app`、`app_token`、`store_id`、`store_type`、`network`、`channel`、`campaign(_network/_id_network)`、`adgroup(_network/_id_network)`、`creative(_network/_id_network)`、`country(_code)`、`region`、`partner(_name/_id)`、`currency(_code)`、`ad_account_id`、`source_network` 等。

**常用指标**：`installs`、`clicks`、`impressions`、`cost`、`network_cost`、`ecpi_network`、`sessions`、`daus`、`retention_rate_d1/d3/d7`、`roas_d1/d3/d7`、`all_revenue` 及自定义事件（如 `register_events`、`firstdeposit_events`）。完整列表见 **Datascape 指标术语表**（`help.adjust.com/zh/article/datascape-metrics-glossary`）。

**响应代码**：`200` 成功；`204` 空结果；`400` 参数错误；`401` Token 缺失/错误；`403` 无权限；`429` 超速率限制；`503/504` 服务不可用/网关超时。

### 1.5 速率限制

按**源 IP** 限制：

- 稳定速率：**50 请求/秒**；突发配额：**100 请求**；
- 多客户端共用 NAT 网关/代理时共享同一限额；
- 超限返回 `429`，官方建议：限制同源 IP 并发、指数退避 + 抖动重试、勿紧密循环重试。

### 1.6 其他数据导出通道（补充）

- **服务器回传**：Adjust 主动向你的服务器实时推送归因详情原始数据（`help.adjust.com/zh/article/server-callbacks`）；
- **云储存上传**：以 CSV 定期上传到云存储（支持卸载/重装等触发器，可自定义占位符字段）；
- **原始数据占位符**：如广告收入 `{revenue_float}`、`{ad_revenue_network}`，花费 `{cost_type}`、`{cost_amount}`、`{reporting_cost}` 等。

## 二、Adjust MCP 对接

> 文档：`help.adjust.com/zh/article/adjust-mcp`（分类：开始使用 → AI）

### 2.1 定位与现状

- **状态**：抢先体验（Early Access）阶段，**必须联系 Adjust 代表或 sales@adjust.com 为账户开通**；
- **本质**：官方托管的 MCP 服务器，把 Adjust **聚合数据**暴露给你自己的 AI 工具，在 Datascape 之外运行；
- **价值**：自然语言查指标；与其他 MCP 集成组合编排 Agent 工作流；拉取表现数据 → 外部分析 → 在其他系统执行操作；
- **与 Growth Copilot 的区别**：MCP 不含 UI、不含 LLM 推理层、无产品内体验，推理完全在你自己的 AI 环境中用你自己的模型/账号完成。

### 2.2 数据与隐私边界

- **仅聚合数据**：不提供用户层级、事件层级明细（非聚合查询不予支持）；
- **不经过 Adjust 托管 LLM**：Adjust 只暴露数据，不做推理；
- 处理与推理均在你选定的 AI 服务商环境中进行，数据主权在自己手里。

### 2.3 连接信息

- **MCP 服务器 URL**：`https://mcp.adjust.com/mcpo`
- **认证**：所有客户端统一走 **OAuth**（早期识别码方式已废弃；迁移方法：终止旧会话 → 新会话 → 按提示完成 OAuth 登录，配置无需其他改动，历史数据可继续访问）；
- **兼容客户端**：支持**所有兼容 MCP 的客户端**；官方指南覆盖 Claude（Desktop/CLI）、Codex（Desktop/CLI）、Cursor，另明确提到 n8n 等自动化平台。

### 2.4 各客户端配置步骤

**Claude（Desktop / CLI）**：
1. 选择 `Connectors` → `+ (Add connector)` → `... Add custom connector`；
2. 输入名称（如 "Adjust MCP"）和 URL `https://mcp.adjust.com/mcpo`；
3. 选择 `添加` → `关联` → 登录 Adjust 并授权。

**Codex（Desktop / CLI）**：
1. `Settings` → `MCP servers` → `+ Add server`；
2. 输入服务器名称，传输类型选 **Streamable HTTP**；
3. URL 填 `https://mcp.adjust.com/mcpo` → `Save` → 登录 Adjust 并授权。

**Cursor**：
1. `自定义 > MCP` → `+ 新 MCP 服务器`；
2. 输入名称与 URL `https://mcp.adjust.com/mcpo` → 保存；
3. 登录 Adjust 并授权（多账户时在授权步骤选择正确账户）。

**生成的标准 JSON 配置**：
```json
{
  "mcpServers": {
    "Adjust MCP": {
      "url": "https://mcp.adjust.com/mcpo"
    }
  }
}
```

### 2.5 故障排查与 FAQ

| 问题 | 处理 |
|---|---|
| MCP 未返回预期结果 | 检查查询是否为聚合数据（用户级/事件级明细不支持） |
| 设置无法工作 | ① 确认账户已开通 MCP；② 确认客户端 URL 配置为 `https://mcp.adjust.com/mcpo` |
| 支持哪些 AI 工具 | 所有兼容 MCP 的客户端；官方提供 Claude/Codex/Cursor 教程 |
| 数据是否给 Adjust 的 LLM | 否，推理全在你自己的 AI 环境 |

## 三、结合当前账号的落地建议

当前账号（Rory Yu，读者角色）已具备的条件与路径：

1. **API 路线（立即可行）**：个人档案中已有 API 识别码，读者角色即可通过 RS API 拉取聚合报告数据，无需额外审批。建议先用 CSV/JSON 终端复刻现有日报（Hatti-Daily 等）的维度+指标组合，实现自动取数；
2. **MCP 路线（需申请）**：需联系 Adjust 代表或 sales@adjust.com 开通抢先体验；开通后在 Cursor/Claude 中配置 `https://mcp.adjust.com/mcpo` 即可用自然语言查询聚合指标；
3. **补齐成本数据（需管理员）**：解决"广告支出为 0"的问题需要渠道方接入**合作伙伴广告支出 API** 或在 AppView 配置 cost integration，这是读者角色无法完成的，需推动管理员执行；
4. **与 pt-ai-acquisition-cause 项目结合**：RS API 的 CSV/JSON 终端可作为项目「数据源 API」的一个标准数据源接入（渠道×日期×事件的聚合事实表），MCP 则可作为 Agent 归因分析时的实时查询工具（对应项目中 MCP 数据源设计）。

## 四、关键链接速查

| 资源 | 地址 |
|---|---|
| Developer Hub | `https://dev.adjust.com/zh` |
| API 总览 | `https://dev.adjust.com/zh/api` |
| 报告服务 API | `https://dev.adjust.com/zh/api/rs-api` |
| RS API 认证 | `https://dev.adjust.com/zh/api/rs-api/authentication` |
| CSV 终端 | `https://dev.adjust.com/zh/api/rs-api/csv` |
| Parquet 终端 | `https://dev.adjust.com/zh/api/rs-api/parquet` |
| 速率限制 | `https://dev.adjust.com/zh/api/rs-api/rate-limits` |
| Adjust MCP | `https://help.adjust.com/zh/article/adjust-mcp` |
| Datascape 指标术语表 | `https://help.adjust.com/zh/article/datascape-metrics-glossary` |
| 服务器回传 | `https://help.adjust.com/zh/article/server-callbacks` |
| MCP 服务器 URL | `https://mcp.adjust.com/mcpo` |
