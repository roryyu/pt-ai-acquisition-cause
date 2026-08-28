import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeReadOnlyQuery, introspectSchema } from "@/lib/server/connectors/postgres";
import { webSearch, fetchPage } from "@/lib/server/connectors/web";
import { executeRestRequest, executeGraphQLQuery } from "@/lib/server/connectors/api";
import { runMcpReactAgent } from "@/lib/server/connectors/mcp";
import { displayEndpoint, type ResolvedDataSource } from "@/lib/server/connectors/datasources";
import { runOperator } from "@/lib/server/operators/registry";
import {
  operatorMetricCatalogSummary, operatorDimensionCatalogSummary,
} from "@/lib/server/operators/data-operators";
import { env } from "@/lib/env";
import { DEMO_SEMANTIC_MODELS, semanticContextSummary } from "@/lib/server/semantic/semantic-query";
import type { AgentRunContext, ChartSpec, TablePayload } from "./events";
import { nextStepId } from "./events";

/**
 * Agent 工具集（LangChain tools，供 LangGraph Agent 调用）
 *
 * 数据分析工具：run_operator / sql_query / inspect_schema / show_table / generate_chart
 * 研究工具：    web_search / fetch_page / record_finding
 * 外部数据源：  query_api_source / query_mcp_source（按已注册数据源动态启用）
 *
 * 每个工具执行时通过 ctx.sink 实时推送 tool_call / tool_result 事件，
 * 前端可完整展示 Agent 的每一步动作与产出。
 */

// ─── 数据分析工具 ─────────────────────────────────────────────────────────────

/** 数据分析算子 ID 枚举（与 registry 数据算子保持一致） */
const DATA_OPERATOR_IDS = ["aggregate", "timeseries", "anomaly", "filter", "transform", "join"] as const;

/** run_operator 工具描述：算子清单 + 指标/维度目录（由语义层动态生成） */
export function runOperatorToolDescription(): string {
  return `执行预置数据分析算子（算子优先原则：标准分析动作必须先调算子，不要自己拼 SQL）。可用算子：
- aggregate 分组聚合：input {metric, groupBy, dimensionValue?, from?, to?}，groupBy 必须是该指标所属模型的维度，可选按维度值过滤，返回分组聚合结果（降序）
- timeseries 时序分析：input {metric, granularity?(day/week/month，默认 month), from?, to?}，输出逐期数值与环比 mom_pct / 同比 yoy_pct
- anomaly 异常检测：input {metric, threshold?(1-5，默认 2), from?, to?}，基于 28 日滚动窗口 Z-Score 检出异常日
- filter 条件下钻：input {model, filters?(维度Id到维度值的对象，如 {"ad_channel":"Meta"}), from?, to?}，按模型全维度分组输出全部指标，用于下钻验证
- transform 派生指标：input {from?, to?}，按月输出投放归因派生指标：CPI（花费/下载）、CPM、CTR、点击注册率、FD 率、RD 率、ROI（充值金额/花费）
- join 跨源关联：input {from?, to?}，投放日汇总 × 投放计划表，按渠道×承接端对比实际效果与计划累计口径
可用指标（metric 参数取值）：
${operatorMetricCatalogSummary()}
各模型可用维度（aggregate 的 groupBy / filter 的 filters 键）：
${operatorDimensionCatalogSummary()}
日期格式 YYYY-MM-DD。`;
}

/** 执行数据分析算子（算子优先于自由 SQL，结果自动注册为表格） */
export function createRunOperatorTool(ctx: AgentRunContext) {
  return tool(
    async (input: { operatorId: (typeof DATA_OPERATOR_IDS)[number]; input: Record<string, unknown> }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "run_operator", input });
      try {
        const result = await runOperator(input.operatorId, input.input);
        if (!result.ok) {
          ctx.sink({
            type: "tool_result", stepId, tool: "run_operator",
            summary: `算子失败: ${result.error}`, elapsedMs: Date.now() - startedAt,
          });
          return JSON.stringify({
            error: result.error,
            hint: "请核对算子参数：metric 必须在指标目录内，groupBy 必须是该指标所属模型的维度，日期格式 YYYY-MM-DD",
          });
        }
        if (result.sql) ctx.dataFindings.sql.push(result.sql);
        // 结果 ≤ 60 行自动注册为表格（与 sql_query 同款展示逻辑）
        if (result.rows.length <= 60) {
          const table: TablePayload = {
            title: `算子结果 · ${input.operatorId}`,
            columns: result.columns,
            rows: result.rows,
            note: `${result.rowCount} 行 · ${result.elapsedMs}ms`,
          };
          ctx.dataFindings.tables.push(table);
          ctx.sink({ type: "table", table });
        }
        ctx.sink({
          type: "tool_result", stepId, tool: "run_operator",
          summary: `算子 ${input.operatorId} 返回 ${result.rowCount} 行`,
          elapsedMs: Date.now() - startedAt,
        });
        const preview = result.rows.slice(0, 100);
        return JSON.stringify({
          columns: result.columns,
          rowCount: result.rowCount,
          rows: preview,
          notes: result.notes,
          note: result.rowCount > 100 ? "结果超 100 行已截断" : "",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "run_operator", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "run_operator",
      description: runOperatorToolDescription(),
      schema: z.object({
        operatorId: z.enum(DATA_OPERATOR_IDS).describe("算子 ID：aggregate/timeseries/anomaly/filter/transform/join"),
        input: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.string())]),
        ).describe("算子参数（按工具描述中各算子的 input 结构传参）"),
      }),
    },
  );
}

/** 只读 SQL 查询（demo schema） */
export function createSqlQueryTool(ctx: AgentRunContext) {
  return tool(
    async (input: { sql: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "sql_query", input });
      try {
        const result = await executeReadOnlyQuery(env.DATABASE_URL, input.sql, {
          maxRows: 300,
          timeoutMs: 20_000,
          schema: "demo",
        });
        ctx.dataFindings.sql.push(input.sql);
        // 自动把结果注册为表格（≤ 60 行时展示）
        if (result.rows.length <= 60) {
          const table: TablePayload = {
            title: "查询结果",
            columns: result.columns,
            rows: result.rows,
            note: `${result.rowCount} 行 · ${result.elapsedMs}ms${result.truncated ? " · 已截断" : ""}`,
          };
          ctx.dataFindings.tables.push(table);
          ctx.sink({ type: "table", table });
        }
        const summary = `返回 ${result.rowCount} 行 (${result.columns.join(", ")})`;
        ctx.sink({
          type: "tool_result", stepId, tool: "sql_query",
          summary, elapsedMs: Date.now() - startedAt,
        });
        // 给模型返回：列名 + 数据（截断至 100 行）+ 提示
        const preview = result.rows.slice(0, 100);
        return JSON.stringify({
          columns: result.columns,
          rowCount: result.rowCount,
          rows: preview,
          note: result.rowCount > 100 ? "结果超 100 行已截断，请缩小范围或聚合" : "",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "sql_query", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg, hint: "请检查 SQL 语法与表/列名（可用 inspect_schema 查看结构）" });
      }
    },
    {
      name: "sql_query",
      description: `对内置演示数据库（PostgreSQL）执行只读 SELECT 查询。当前 search_path=demo。可用表：daily_metrics(stat_date,region,channel,gmv,orders,active_users,new_users,conversion_rate,avg_order_value)、orders(order_no,user_id,region,channel,category,product_id,amount,quantity,status,created_at)、products(name,category,price,cost)、regions(name,tier)、channel_daily_metrics(stat_date,ad_channel,platform,region,spend,impressions,clicks,downloads,registrations,fd_users,fd_amount,rd_users,rd_amount；投放渠道效果分析：ad_channel取值Meta/X/TikTok，platform取值app/web，fd=首次充钱，rd=召回再充钱)、channel_campaigns(campaign_no,ad_channel,platform,objective,campaign_name,status,start_date,daily_budget,total_spend,downloads,registrations,fd_users,rd_users)。日期列 daily_metrics.stat_date 与 channel_daily_metrics.stat_date 为 DATE 类型。仅允许单条 SELECT/WITH 语句。`,
      schema: z.object({
        sql: z.string().describe("只读 SQL 查询语句（SELECT 或 WITH 开头）"),
      }),
    },
  );
}

/** 查看库表结构 */
export function createInspectSchemaTool(ctx: AgentRunContext) {
  return tool(
    async (input: { table?: string }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "inspect_schema", input });
      try {
        if (input.table) {
          const tables = await introspectSchema(env.DATABASE_URL, "demo");
          const target = tables.find((t) => t.table === input.table);
          if (!target) {
            ctx.sink({ type: "tool_result", stepId, tool: "inspect_schema", summary: `表 ${input.table} 不存在` });
            return JSON.stringify({ error: `表 demo.${input.table} 不存在`, available: tables.map((t) => t.table) });
          }
          ctx.sink({
            type: "tool_result", stepId, tool: "inspect_schema",
            summary: `${target.table}（${target.columns.length} 列）`,
          });
          return JSON.stringify(target);
        }
        const tables = await introspectSchema(env.DATABASE_URL, "demo");
        ctx.sink({
          type: "tool_result", stepId, tool: "inspect_schema",
          summary: `demo schema 共 ${tables.length} 张表`,
        });
        return JSON.stringify(tables.map((t) => ({
          table: t.table, columns: t.columns.map((c) => `${c.name}:${c.dataType}`),
        })));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "inspect_schema", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "inspect_schema",
      description: "查看演示数据库 demo schema 的表结构：不传 table 返回所有表概览；传 table 返回该表列名与类型。",
      schema: z.object({
        table: z.string().optional().describe("表名（可选），如 daily_metrics"),
      }),
    },
  );
}

/** 展示数据表格（Agent 主动向用户展示中间结果） */
export function createShowTableTool(ctx: AgentRunContext) {
  return tool(
    async (input: { title: string; columns: string[]; rows: Record<string, unknown>[] }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "show_table", input: { title: input.title, columns: input.columns, rowCount: input.rows.length } });
      const table: TablePayload = {
        title: input.title,
        columns: input.columns,
        rows: input.rows.slice(0, 100),
      };
      ctx.dataFindings.tables.push(table);
      ctx.sink({ type: "table", table });
      ctx.sink({ type: "tool_result", stepId, tool: "show_table", summary: `已展示 ${table.rows.length} 行` });
      return JSON.stringify({ ok: true, displayed: table.rows.length });
    },
    {
      name: "show_table",
      description: "将结构化数据以表格形式展示给用户。columns 为列名数组，rows 为对象数组（字段名与 columns 对应），最多 100 行。",
      schema: z.object({
        title: z.string().describe("表格标题"),
        columns: z.array(z.string()).describe("列名"),
        rows: z.array(z.record(z.string(), z.unknown())).describe("数据行"),
      }),
    },
  );
}

/** 生成图表（Agent 输出 ChartSpec，前端 Recharts 渲染） */
export function createGenerateChartTool(ctx: AgentRunContext) {
  return tool(
    async (input: {
      chartType: "bar" | "line" | "area" | "pie" | "radar";
      title: string;
      xKey: string;
      yKeys: string[];
      data: Record<string, unknown>[];
      xLabel?: string;
      yLabel?: string;
      unit?: string;
    }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "generate_chart", input: { chartType: input.chartType, title: input.title, xKey: input.xKey, yKeys: input.yKeys, dataRows: input.data.length } });
      const chart: ChartSpec = {
        type: input.chartType,
        title: input.title,
        xKey: input.xKey,
        yKeys: input.yKeys,
        data: input.data.slice(0, 200),
        xLabel: input.xLabel,
        yLabel: input.yLabel,
        unit: input.unit,
      };
      ctx.dataFindings.charts.push(chart);
      ctx.sink({ type: "chart", chart });
      ctx.sink({ type: "tool_result", stepId, tool: "generate_chart", summary: `已生成${chartTypeLabel(input.chartType)}「${input.title}」（${chart.data.length} 个数据点）` });
      return JSON.stringify({ ok: true, rendered: chart.data.length });
    },
    {
      name: "generate_chart",
      description: `生成图表并展示给用户。选型建议：分类对比→bar；时间趋势→line/area；占比构成→pie（yKeys 传一个）；多维评估→radar。data 每行需含 xKey 字段和全部 yKeys 字段，数值必须为 number 类型，最多 200 行。示例：{"chartType":"bar","title":"各大区GMV","xKey":"region","yKeys":["gmv"],"data":[{"region":"华东","gmv":100}],"unit":"元"}`,
      schema: z.object({
        chartType: z.enum(["bar", "line", "area", "pie", "radar"]).describe("图表类型"),
        title: z.string().describe("图表标题"),
        xKey: z.string().describe("X 轴字段名（data 中的 key）"),
        yKeys: z.array(z.string()).min(1).describe("Y 轴数值字段名列表"),
        data: z.array(z.record(z.string(), z.unknown())).min(1).describe("数据行数组"),
        xLabel: z.string().optional().describe("X 轴显示名"),
        yLabel: z.string().optional().describe("Y 轴显示名"),
        unit: z.string().optional().describe("数值单位（元/单/%等）"),
      }),
    },
  );
}

function chartTypeLabel(type: string): string {
  const map: Record<string, string> = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图", radar: "雷达图" };
  return map[type] ?? type;
}

// ─── 研究工具 ─────────────────────────────────────────────────────────────────

/** 互联网搜索（预算控制：单次任务最多 8 次检索，防止无限搜索循环） */
export function createWebSearchTool(ctx: AgentRunContext) {
  return tool(
    async (input: { query: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "web_search", input });
      // 搜索预算：超出后强制模型转入记录/总结阶段
      if (ctx.researchFindings.searchedQueries.length >= 8) {
        ctx.sink({
          type: "tool_result", stepId, tool: "web_search",
          summary: "搜索预算已用完（8 次），请停止检索",
        });
        return JSON.stringify({
          error: "搜索预算已用完（最多 8 次检索）",
          hint: "请立即改用 record_finding 记录已有发现（基于已检索到的摘要），然后输出最终回答。不要再调用 web_search。",
        });
      }
      try {
        const results = await webSearch(input.query, 6);
        ctx.researchFindings.searchedQueries.push(input.query);
        // 注册引用 + 保存摘要（供兜底转正）
        for (const r of results) {
          const existing = ctx.researchFindings.citations.find((c) => c.url === r.url);
          if (!existing) {
            const no = ctx.researchFindings.citations.length + 1;
            ctx.researchFindings.citations.push({ no, title: r.title, url: r.url });
            if (r.snippet.trim().length > 30) {
              ctx.researchFindings.searchSnippets.push({ no, title: r.title, snippet: r.snippet.trim() });
            }
          }
        }
        ctx.sink({ type: "citations", citations: ctx.researchFindings.citations });
        ctx.sink({
          type: "tool_result", stepId, tool: "web_search",
          summary: results.length > 0 ? `检索到 ${results.length} 条结果` : "无结果",
          elapsedMs: Date.now() - startedAt,
        });
        const remaining = 8 - ctx.researchFindings.searchedQueries.length;
        return JSON.stringify({
          results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
          note:
            remaining <= 0
              ? "⚠️ 搜索预算已用完，请立即用 record_finding 记录发现并输出最终回答"
              : remaining <= 2
                ? `剩余搜索次数不多（${remaining} 次），请尽快转入 fetch_page 深读或 record_finding 记录`
                : "",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "web_search", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "web_search",
      description: "搜索互联网公开信息，返回标题/链接/摘要。适合行业趋势、竞品动态、政策法规、市场数据等外部信息检索。用中文搜索中文内容，英文搜索英文内容。注意：整个任务最多搜索 8 次，请精炼关键词避免浪费预算。",
      schema: z.object({
        query: z.string().min(2).max(200).describe("搜索关键词（精炼，避免整句）"),
      }),
    },
  );
}

/** 抓取网页正文（预算控制：单次任务最多 6 页） */
export function createFetchPageTool(ctx: AgentRunContext) {
  return tool(
    async (input: { url: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "fetch_page", input });
      if (ctx.researchFindings.fetchedUrls.length >= 6) {
        ctx.sink({
          type: "tool_result", stepId, tool: "fetch_page",
          summary: "抓取预算已用完（6 页），请转入 record_finding",
        });
        return JSON.stringify({
          error: "抓取预算已用完（最多 6 页）",
          hint: "请基于已抓取的内容用 record_finding 记录发现，然后输出最终回答。",
        });
      }
      try {
        const page = await fetchPage(input.url, 6000);
        ctx.researchFindings.fetchedUrls.push(input.url);
        ctx.sink({
          type: "tool_result", stepId, tool: "fetch_page",
          summary: `${page.title.slice(0, 40)}（${page.wordCount} 字）`,
          elapsedMs: Date.now() - startedAt,
        });
        return JSON.stringify({ title: page.title, url: page.url, text: page.text });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "fetch_page", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg, hint: "该站点可能阻止抓取，换一个来源试试" });
      }
    },
    {
      name: "fetch_page",
      description: "抓取指定 URL 的网页正文（已去除导航等噪声）。用于深入阅读搜索结果中的关键页面，提取详细事实与数据。整个任务最多抓取 6 页，优先选择最相关的页面。",
      schema: z.object({
        url: z.string().url().describe("要抓取的网页 URL（必须 http/https）"),
      }),
    },
  );
}

/** 记录研究发现 */
export function createRecordFindingTool(ctx: AgentRunContext) {
  return tool(
    async (input: { finding: string }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "record_finding", input: { finding: input.finding.slice(0, 80) } });
      ctx.researchFindings.notes.push(input.finding);
      ctx.sink({
        type: "tool_result", stepId, tool: "record_finding",
        summary: `已记录发现 #${ctx.researchFindings.notes.length}`,
      });
      return JSON.stringify({ ok: true, totalNotes: ctx.researchFindings.notes.length });
    },
    {
      name: "record_finding",
      description: "记录一条重要研究发现（含数据/结论/来源编号），将进入最终报告的证据池。每完成一个子问题的研究就记录一次。",
      schema: z.object({
        finding: z.string().min(5).max(1000).describe("研究发现，建议包含数据与来源编号如 [1]"),
      }),
    },
  );
}

// ─── 外部数据源工具（已注册的 api / mcp 数据源） ────────────────────────────

/** 数据源清单描述（供工具 description / 提示词枚举） */
export function externalSourcesSummary(sources: ResolvedDataSource[]): string {
  return sources
    .map((s) => {
      if (s.type === "api") {
        return `- ${s.name}（sourceId=${s.id}，API·${s.apiConfig?.protocol === "graphql" ? "GraphQL" : "REST"}，${displayEndpoint(s)}）`;
      }
      return `- ${s.name}（sourceId=${s.id}，MCP 代理，${displayEndpoint(s)}）`;
    })
    .join("\n");
}

/** 调用已注册 API 数据源（REST/GraphQL，预算：单次任务最多 6 次） */
export function createApiSourceTool(ctx: AgentRunContext, sources: ResolvedDataSource[]) {
  const apiSources = sources.filter((s) => s.type === "api" && s.apiConfig);
  let calls = 0;
  return tool(
    async (input: {
      sourceId: string;
      path?: string;
      method?: "GET" | "POST";
      params?: Record<string, string>;
      body?: string;
      graphqlQuery?: string;
      variables?: Record<string, unknown>;
    }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "query_api_source", input: { sourceId: input.sourceId, path: input.path, graphqlQuery: input.graphqlQuery?.slice(0, 120) } });
      if (calls >= 6) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: "API 调用预算已用完（6 次）" });
        return JSON.stringify({ error: "API 调用预算已用完（最多 6 次）", hint: "请基于已有数据继续分析或输出回答" });
      }
      const source = apiSources.find((s) => s.id === input.sourceId);
      if (!source?.apiConfig) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: `数据源 ${input.sourceId} 不存在` });
        return JSON.stringify({ error: `API 数据源 ${input.sourceId} 不存在`, available: apiSources.map((s) => s.id) });
      }
      calls += 1;
      try {
        if (source.apiConfig.protocol === "graphql") {
          if (!input.graphqlQuery) {
            return JSON.stringify({ error: "该数据源为 GraphQL 协议，必须提供 graphqlQuery 参数" });
          }
          const result = await executeGraphQLQuery(source.apiConfig, {
            query: input.graphqlQuery,
            variables: input.variables,
          });
          ctx.sink({
            type: "tool_result", stepId, tool: "query_api_source",
            summary: `GraphQL 查询完成${result.errors?.length ? `（含 ${result.errors.length} 个错误）` : ""}`,
            elapsedMs: Date.now() - startedAt,
          });
          return JSON.stringify({ data: result.data, errors: result.errors }).slice(0, 20_000);
        }
        let parsedBody: unknown;
        if (input.body) {
          try {
            parsedBody = JSON.parse(input.body);
          } catch {
            parsedBody = input.body;
          }
        }
        const result = await executeRestRequest(source.apiConfig, {
          method: input.method ?? "GET",
          path: input.path,
          params: input.params,
          body: parsedBody,
        });
        ctx.sink({
          type: "tool_result", stepId, tool: "query_api_source",
          summary: `HTTP ${result.status}（${result.elapsedMs}ms）`,
          elapsedMs: Date.now() - startedAt,
        });
        return JSON.stringify({ status: result.status, body: result.body, truncated: result.truncated }).slice(0, 20_000);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "query_api_source",
      description: `调用已注册的外部 API 数据源获取数据（只读）。REST 源传 path/method/params/body；GraphQL 源传 graphqlQuery/variables（禁止 mutation）。整个任务最多调用 6 次。可用数据源：\n${externalSourcesSummary(apiSources)}`,
      schema: z.object({
        sourceId: z.string().describe("数据源 ID（见工具描述中的可用数据源）"),
        path: z.string().optional().describe("REST：相对路径，如 /v1/users"),
        method: z.enum(["GET", "POST"]).optional().describe("REST：请求方法，默认 GET"),
        params: z.record(z.string(), z.string()).optional().describe("REST：query 参数"),
        body: z.string().optional().describe("REST POST：JSON 字符串请求体"),
        graphqlQuery: z.string().optional().describe("GraphQL：查询语句（仅 query）"),
        variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL：变量"),
      }),
    },
  );
}

/** 调用已注册 MCP 数据源（子 ReAct Agent，预算：单次任务最多 3 次） */
export function createMcpSourceTool(ctx: AgentRunContext, sources: ResolvedDataSource[]) {
  const mcpSources = sources.filter((s) => s.type === "mcp" && s.mcpConfig);
  let calls = 0;
  return tool(
    async (input: { sourceId: string; task: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "query_mcp_source", input: { sourceId: input.sourceId, task: input.task.slice(0, 120) } });
      if (calls >= 3) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_mcp_source", summary: "MCP 调用预算已用完（3 次）" });
        return JSON.stringify({ error: "MCP 调用预算已用完（最多 3 次）", hint: "请基于已有数据继续分析或输出回答" });
      }
      const source = mcpSources.find((s) => s.id === input.sourceId);
      if (!source?.mcpConfig) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_mcp_source", summary: `数据源 ${input.sourceId} 不存在` });
        return JSON.stringify({ error: `MCP 数据源 ${input.sourceId} 不存在`, available: mcpSources.map((s) => s.id) });
      }
      calls += 1;
      try {
        const result = await runMcpReactAgent(source.mcpConfig, input.task, (step) => {
          // 子 Agent 的每步工具调用同步外送，前端可观察完整链路
          const subStepId = nextStepId(ctx);
          ctx.sink({ type: "tool_call", stepId: subStepId, tool: `mcp:${step.tool}`, input: step.input });
          ctx.sink({
            type: "tool_result", stepId: subStepId, tool: `mcp:${step.tool}`,
            summary: step.output.slice(0, 120), elapsedMs: step.elapsedMs,
          });
        });
        ctx.sink({
          type: "tool_result", stepId, tool: "query_mcp_source",
          summary: `MCP Agent 完成（${result.steps.length} 步工具调用）`,
          elapsedMs: Date.now() - startedAt,
        });
        return JSON.stringify({ answer: result.answer, toolSteps: result.steps.length }).slice(0, 20_000);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "query_mcp_source", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg, hint: "MCP 代理可能不可用，请换其他数据源或说明情况" });
      }
    },
    {
      name: "query_mcp_source",
      description: `向已注册的 MCP 数据源下达自然语言数据获取任务，由子 Agent 自主调用 MCP 工具完成并返回结果。任务描述要具体（含时间范围/字段/过滤条件）。整个任务最多调用 3 次。可用数据源：\n${externalSourcesSummary(mcpSources)}`,
      schema: z.object({
        sourceId: z.string().describe("数据源 ID（见工具描述中的可用数据源）"),
        task: z.string().min(2).describe("自然语言任务，如：查询 2026 年 8 月华东大区的工单量"),
      }),
    },
  );
}

// ─── 语义上下文（供提示词构建） ────────────────────────────────────────────────

export function semanticContextForPrompt(): string {
  return semanticContextSummary();
}

export function demoTablesHint(): string {
  return DEMO_SEMANTIC_MODELS.map(
    (m) => `- demo.${m.table}（${m.name}）：${m.dimensions.map((d) => d.id).join(", ")} | 指标：${m.metrics.map((x) => x.id).join(", ")}`,
  ).join("\n");
}
