"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Database, Globe, Loader2, Plug, Plus, Table as TableIcon, Eye,
  TerminalSquare, CheckCircle2, XCircle, ChevronDown, ChevronRight, Shield,
  Webhook, Bot, Trash2, Play, Wrench, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable } from "@/components/data/DataTable";

/**
 * 数据源管理（design.md 5.1 数据接入层管理台）
 * - bi（PostgreSQL）：连接测试 + Schema 内省浏览 + 数据预览 + 只读 SQL 查询台
 * - api（REST / GraphQL）：连接测试 + 请求调试台 + GraphQL Schema 浏览
 * - mcp（MCP 代理）：连接测试 + 工具列表 + 单工具调用 + ReAct Agent 调试
 */

interface DataSourceItem {
  id: string;
  name: string;
  type: string;
  builtin: boolean;
  status: string;
  createdAt: string | null;
  endpoint: string;
  meta: { protocol: "rest" | "graphql"; authType: string } | null;
}

interface TableMetaItem {
  schema: string;
  table: string;
  rowCount: number | null;
  columns: Array<{ name: string; dataType: string; nullable: boolean }>;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  truncated?: boolean;
}

export function DataSourcesClient() {
  const [sources, setSources] = useState<DataSourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 测试状态
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Schema 浏览
  const [tables, setTables] = useState<TableMetaItem[]>([]);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ table: string; result: QueryResult } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // SQL 查询台
  const [sql, setSql] = useState("SELECT region, SUM(gmv)::numeric(14,2) AS gmv\nFROM demo.daily_metrics\nWHERE stat_date >= '2026-01-01'\nGROUP BY region\nORDER BY gmv DESC");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [queryError, setQueryError] = useState("");

  const selected = sources.find((s) => s.id === selectedId) ?? null;
  const isPg = selected?.type === "bi";

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/datasources");
      const json = await res.json();
      if (json.ok) {
        setSources(json.data.dataSources ?? []);
        setSelectedId((prev) => prev ?? json.data.dataSources?.[0]?.id ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  /** 连接测试 */
  const runTest = useCallback(async () => {
    if (!selectedId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/v1/datasources/${selectedId}/test`, { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        const d = json.data;
        let text: string;
        if (!d.ok) {
          text = `连接失败：${d.error ?? "未知错误"}`;
        } else if (d.kind === "web") {
          text = `连接正常 · 搜索可用（返回 ${d.sampleCount} 条样本）`;
        } else if (d.kind === "mcp") {
          text = `连接正常 · MCP 代理可用 · 发现 ${d.toolCount} 个工具`;
        } else if (d.kind === "rest" || d.kind === "graphql") {
          text = `连接正常 · ${d.kind === "graphql" ? "GraphQL" : "REST"} endpoint 可达（HTTP ${d.statusCode}）· 延迟 ${d.latencyMs}ms`;
        } else {
          text = `连接正常 · ${d.serverVersion ?? "PostgreSQL"} · 延迟 ${d.latencyMs}ms · schema: ${(d.schemas ?? []).join(", ")}`;
        }
        setTestResult(text);
      } else {
        setTestResult(`连接失败：${json.error?.message ?? "未知错误"}`);
      }
    } catch (err) {
      setTestResult(`连接失败：${err instanceof Error ? err.message : "网络异常"}`);
    } finally {
      setTesting(false);
    }
  }, [selectedId]);

  /** 切换到 PostgreSQL 数据源时自动加载 Schema（setState 均在异步回调中，避免 effect 内同步更新） */
  useEffect(() => {
    if (!selectedId || !isPg) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoadingSchema(true);
      setTables([]);
      setPreview(null);
      setQueryResult(null);
    });
    fetch(`/api/v1/datasources/${selectedId}/schema`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled && json.ok) setTables(json.data.tables ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingSchema(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, isPg]);

  /** 预览表数据 */
  const previewTable = useCallback(
    async (schema: string, table: string) => {
      if (!selectedId) return;
      setLoadingPreview(true);
      setExpandedTable(`${schema}.${table}`);
      try {
        const res = await fetch(`/api/v1/datasources/${selectedId}/preview?schema=${schema}&table=${table}&limit=50`);
        const json = await res.json();
        if (json.ok) {
          setPreview({ table: `${schema}.${table}`, result: json.data });
        }
      } finally {
        setLoadingPreview(false);
      }
    },
    [selectedId],
  );

  /** 执行只读 SQL */
  const runQuery = useCallback(async () => {
    if (!selectedId || !sql.trim()) return;
    setRunning(true);
    setQueryError("");
    setQueryResult(null);
    try {
      const res = await fetch(`/api/v1/datasources/${selectedId}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql, schema: "demo", maxRows: 200 }),
      });
      const json = await res.json();
      if (json.ok) {
        setQueryResult(json.data);
      } else {
        setQueryError(json.error?.message ?? "查询失败");
      }
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setRunning(false);
    }
  }, [selectedId, sql]);

  /** 删除自定义数据源 */
  const deleteSource = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(`确定删除数据源「${name}」？`)) return;
      const res = await fetch(`/api/v1/datasources/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (json.ok) {
        setSelectedId((prev) => (prev === id ? null : prev));
        loadSources();
      }
    },
    [loadSources],
  );

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>数据源管理</h1>
          <p className="mt-0.5 text-sm" style={{ color: "var(--muted)" }}>
            连接外部数据库与互联网数据源，浏览表结构、预览数据、执行只读查询
          </p>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          className="flex items-center gap-1.5 rounded-[9px] px-3 py-2 text-xs font-medium transition-transform hover:-translate-y-0.5"
          style={{ background: "var(--purple)", color: "#fff" }}
        >
          <Plus size={14} /> 注册数据源
        </button>
      </header>

      {creating && <CreateSourceForm onCreated={() => { setCreating(false); loadSources(); }} />}

      <div className="flex gap-5">
        {/* ── 数据源列表 ── */}
        <aside className="w-80 shrink-0 space-y-3">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="animate-spin" style={{ color: "var(--muted)" }} />
            </div>
          ) : (
            sources.map((s) => (
              <div
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  "w-full cursor-pointer rounded-[var(--radius-sm)] border p-4 text-left transition-all hover:-translate-y-0.5",
                )}
                style={{
                  borderColor: selectedId === s.id ? "var(--purple)" : "var(--line)",
                  background: "var(--surface)",
                  boxShadow: selectedId === s.id ? "0 0 0 3px var(--purple-pale)" : undefined,
                }}
              >
                <div className="flex items-center gap-2">
                  <SourceIcon type={s.type} />
                  <span className="flex-1 truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {s.name}
                  </span>
                  {s.builtin ? (
                    <span
                      className="rounded-full px-1.5 py-px text-xs"
                      style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
                    >
                      内置
                    </span>
                  ) : (
                    <span
                      role="button"
                      title="删除数据源"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSource(s.id, s.name);
                      }}
                      className="rounded p-1 transition-colors hover:bg-black/[0.05]"
                      style={{ color: "var(--muted)" }}
                    >
                      <Trash2 size={13} />
                    </span>
                  )}
                </div>
                <p className="mt-1.5 truncate text-xs" style={{ color: "var(--muted)" }}>{s.endpoint}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {sourceTypeLabel(s)}
                  </span>
                  <span
                    className="flex items-center gap-1 text-xs"
                    style={{ color: s.status === "active" ? "var(--success)" : "var(--danger)" }}
                  >
                    <CheckCircle2 size={11} />
                    {s.status === "active" ? "可用" : "配置缺失"}
                  </span>
                </div>
              </div>
            ))
          )}
        </aside>

        {/* ── 详情区 ── */}
        <div className="min-w-0 flex-1 space-y-5">
          {/* 连接测试 */}
          <section
            className="rounded-[var(--radius-sm)] border p-5"
            style={{ borderColor: "var(--line)", background: "var(--surface)" }}
          >
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                <Plug size={15} style={{ color: "var(--purple)" }} />
                连接测试 · {selected?.name}
              </h2>
              <button
                onClick={runTest}
                disabled={testing || !selected}
                className="flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs transition-colors hover:bg-black/[0.03] disabled:opacity-50"
                style={{ borderColor: "var(--purple)", color: "var(--purple)" }}
              >
                {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
                {testing ? "测试中..." : "测试连接"}
              </button>
            </div>
            {testResult && (
              <p
                className="mt-3 flex items-center gap-1.5 rounded-[8px] px-3 py-2 text-xs"
                style={{
                  background: testResult.startsWith("连接正常") ? "var(--success-pale)" : "var(--danger-pale)",
                  color: testResult.startsWith("连接正常") ? "var(--success)" : "var(--danger)",
                }}
              >
                {testResult.startsWith("连接正常") ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {testResult}
              </p>
            )}
          </section>

          {isPg && (
            <>
              {/* Schema 浏览 */}
              <section
                className="rounded-[var(--radius-sm)] border p-5"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                  <TableIcon size={15} style={{ color: "var(--purple)" }} />
                  Schema 浏览
                  <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>
                    {tables.length} 张表 · 点击表名查看列结构与数据预览
                  </span>
                </h2>
                {loadingSchema ? (
                  <div className="flex justify-center py-6">
                    <Loader2 size={20} className="animate-spin" style={{ color: "var(--purple)" }} />
                  </div>
                ) : (
                  <div className="mt-3 space-y-1.5">
                    {tables.map((t) => {
                      const key = `${t.schema}.${t.table}`;
                      const isExpanded = expandedTable === key;
                      return (
                        <div key={key} className="rounded-[8px] border" style={{ borderColor: "var(--line)" }}>
                          <button
                            onClick={() => (isExpanded ? setExpandedTable(null) : previewTable(t.schema, t.table))}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-black/[0.02]"
                          >
                            {isExpanded ? (
                              <ChevronDown size={13} style={{ color: "var(--muted)" }} />
                            ) : (
                              <ChevronRight size={13} style={{ color: "var(--muted)" }} />
                            )}
                            <span className="font-semibold" style={{ color: "var(--ink)" }}>
                              {t.schema}.{t.table}
                            </span>
                            <span style={{ color: "var(--muted)" }}>
                              {t.rowCount !== null ? `${t.rowCount.toLocaleString()} 行` : ""}
                            </span>
                            <span className="flex-1" />
                            <span className="flex items-center gap-1" style={{ color: "var(--purple)" }}>
                              <Eye size={12} /> 预览
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="border-t px-3 py-2" style={{ borderColor: "var(--line)" }}>
                              <div className="mb-2 flex flex-wrap gap-1.5">
                                {t.columns.map((c) => (
                                  <span
                                    key={c.name}
                                    className="rounded-full px-2 py-0.5 text-xs"
                                    style={{ background: "var(--purple-pale)", color: "var(--ink-soft)" }}
                                    title={`${c.dataType}${c.nullable ? " · 可空" : " · 非空"}`}
                                  >
                                    {c.name}
                                    <span className="ml-1 opacity-60">{c.dataType}</span>
                                  </span>
                                ))}
                              </div>
                              {loadingPreview && !preview ? (
                                <div className="flex justify-center py-3">
                                  <Loader2 size={16} className="animate-spin" style={{ color: "var(--purple)" }} />
                                </div>
                              ) : preview && preview.table === key ? (
                                <DataTable
                                  title={`${key} 数据预览`}
                                  columns={preview.result.columns}
                                  rows={preview.result.rows}
                                  note={`前 ${preview.result.rows.length} 行`}
                                  defaultOpen
                                />
                              ) : null}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* SQL 查询台 */}
              <section
                className="rounded-[var(--radius-sm)] border p-5"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                  <TerminalSquare size={15} style={{ color: "var(--purple)" }} />
                  SQL 查询台
                  <span
                    className="flex items-center gap-1 rounded-full px-2 py-px text-xs font-normal"
                    style={{ background: "var(--success-pale)", color: "var(--success)" }}
                  >
                    <Shield size={10} /> 只读 · SELECT-ONLY
                  </span>
                </h2>
                <textarea
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="mt-3 w-full resize-y rounded-[8px] border p-3 font-mono text-xs outline-none focus:border-[var(--purple)]"
                  style={{ borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink)" }}
                  placeholder="输入只读 SQL（SELECT / WITH 开头）"
                />
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    执行于 {selected?.name}（search_path=demo，超时 20s，最多 200 行）
                  </p>
                  <button
                    onClick={runQuery}
                    disabled={running || !sql.trim()}
                    className="flex items-center gap-1.5 rounded-[8px] px-4 py-1.5 text-xs font-medium transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                    style={{ background: "var(--purple)", color: "#fff" }}
                  >
                    {running ? <Loader2 size={13} className="animate-spin" /> : <TerminalSquare size={13} />}
                    {running ? "执行中..." : "执行查询"}
                  </button>
                </div>
                {queryError && (
                  <p className="mt-3 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                    {queryError}
                  </p>
                )}
                {queryResult && (
                  <div className="mt-3">
                    <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
                      {queryResult.rowCount} 行 · {queryResult.elapsedMs}ms{queryResult.truncated ? " · 已截断" : ""}
                    </p>
                    <DataTable
                      columns={queryResult.columns}
                      rows={queryResult.rows}
                      defaultOpen
                      maxHeight={360}
                    />
                  </div>
                )}
              </section>
            </>
          )}

          {selected?.type === "api" && <ApiSourcePanel key={selected.id} source={selected} />}

          {selected?.type === "mcp" && <McpSourcePanel key={selected.id} source={selected} />}

          {selected?.type === "web" && (
            <section
              className="rounded-[var(--radius-sm)] border p-8 text-center"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}
            >
              <Globe size={32} className="mx-auto" style={{ color: "var(--warning)" }} />
              <p className="mt-3 text-sm" style={{ color: "var(--ink)" }}>互联网检索数据源</p>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                无 Schema 与表结构概念，由深度研究任务经研究算子调用（SearchOp 检索 / ExtractOp 抽取），
                可用「连接测试」验证搜索可用性
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** 数据源类型图标 */
function SourceIcon({ type }: { type: string }) {
  if (type === "web") return <Globe size={16} style={{ color: "var(--warning)" }} />;
  if (type === "api") return <Webhook size={16} style={{ color: "var(--purple)" }} />;
  if (type === "mcp") return <Bot size={16} style={{ color: "var(--purple)" }} />;
  return <Database size={16} style={{ color: "var(--purple)" }} />;
}

/** 数据源类型标签 */
function sourceTypeLabel(s: DataSourceItem): string {
  if (s.type === "web") return "Web 检索";
  if (s.type === "api") return s.meta?.protocol === "graphql" ? "API · GraphQL" : "API · REST";
  if (s.type === "mcp") return "MCP 代理";
  return "PostgreSQL";
}

/** 解析多行 header 文本（每行 Key: Value） */
function parseHeaderLines(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** JSON 结果展示 */
function JsonView({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="mt-2 overflow-auto rounded-[8px] border p-3 font-mono text-xs leading-relaxed"
      style={{ borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink)", maxHeight }}
    >
      {text}
    </pre>
  );
}

const inputCls = "rounded-[8px] border px-3 py-2 text-sm outline-none focus:border-[var(--purple)]";
const inputStyle = { borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink)" } as const;
const monoInputCls = "rounded-[8px] border px-3 py-2 font-mono text-xs outline-none focus:border-[var(--purple)]";

/** 注册自定义数据源表单（bi / api / mcp） */
function CreateSourceForm({ onCreated }: { onCreated: () => void }) {
  const [type, setType] = useState<"bi" | "api" | "mcp">("bi");
  const [name, setName] = useState("");
  // bi
  const [url, setUrl] = useState("");
  // api
  const [endpoint, setEndpoint] = useState("");
  const [protocol, setProtocol] = useState<"rest" | "graphql">("rest");
  const [authType, setAuthType] = useState<"none" | "bearer" | "api_key" | "basic">("none");
  const [authToken, setAuthToken] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("");
  // mcp
  const [proxyUrl, setProxyUrl] = useState("");
  // api / mcp 共用：自定义 header
  const [headersText, setHeadersText] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = useCallback(async () => {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    let payload: Record<string, unknown>;
    if (type === "bi") {
      if (!url.trim()) {
        setError("连接串不能为空");
        return;
      }
      payload = { type, name: name.trim(), connectionUrl: url.trim() };
    } else if (type === "api") {
      if (!endpoint.trim()) {
        setError("endpoint 不能为空");
        return;
      }
      payload = {
        type, name: name.trim(), endpoint: endpoint.trim(), protocol, authType,
        ...(authType !== "none" && authToken.trim() ? { authToken: authToken.trim() } : {}),
        ...(authType === "api_key" && apiKeyHeader.trim() ? { apiKeyHeader: apiKeyHeader.trim() } : {}),
        ...(parseHeaderLines(headersText) ? { headers: parseHeaderLines(headersText) } : {}),
      };
    } else {
      if (!proxyUrl.trim()) {
        setError("代理地址不能为空");
        return;
      }
      payload = {
        type, name: name.trim(), proxyUrl: proxyUrl.trim(),
        ...(parseHeaderLines(headersText) ? { headers: parseHeaderLines(headersText) } : {}),
      };
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/v1/datasources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.ok) onCreated();
      else setError(json.error?.message ?? "创建失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setSubmitting(false);
    }
  }, [type, name, url, endpoint, protocol, authType, authToken, apiKeyHeader, proxyUrl, headersText, onCreated]);

  const typeOptions = [
    { value: "bi" as const, label: "PostgreSQL", desc: "只读分析库" },
    { value: "api" as const, label: "API 接口", desc: "REST / GraphQL" },
    { value: "mcp" as const, label: "MCP 代理", desc: "第三方 MCP 服务" },
  ];

  return (
    <section
      className="rounded-[var(--radius-sm)] border p-5"
      style={{ borderColor: "var(--purple)", background: "var(--surface)" }}
    >
      <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>注册数据源</h2>

      {/* 类型 tab 页 */}
      <div
        className="mt-3 flex gap-1 border-b"
        style={{ borderColor: "var(--line)" }}
        role="tablist"
        aria-label="数据源类型"
      >
        {typeOptions.map((t) => {
          const active = type === t.value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => setType(t.value)}
              className="-mb-px border-b-2 px-4 py-2 text-left text-xs transition-colors"
              style={{
                borderColor: active ? "var(--purple)" : "transparent",
                color: active ? "var(--ink)" : "var(--muted)",
              }}
            >
              <span className={active ? "font-semibold" : ""}>{t.label}</span>
              <span className="ml-1.5" style={{ color: "var(--muted)" }}>{t.desc}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="数据源名称（如：生产经营库 / 开放平台 API）"
          className={inputCls}
          style={inputStyle}
        />

        {type === "bi" && (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="postgresql://user:pass@host:5432/db"
            className={monoInputCls}
            style={inputStyle}
          />
        )}

        {type === "api" && (
          <>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://open.example.com/api 或 GraphQL endpoint"
              className={monoInputCls}
              style={inputStyle}
            />
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as "rest" | "graphql")}
              className={inputCls}
              style={inputStyle}
            >
              <option value="rest">REST</option>
              <option value="graphql">GraphQL</option>
            </select>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as typeof authType)}
              className={inputCls}
              style={inputStyle}
            >
              <option value="none">无需认证</option>
              <option value="bearer">Bearer Token</option>
              <option value="api_key">API Key（Header）</option>
              <option value="basic">Basic Auth</option>
            </select>
            {authType !== "none" && (
              <input
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                type="password"
                placeholder={authType === "basic" ? "base64(user:pass)" : "凭证值（仅存服务端，不回显）"}
                className={monoInputCls}
                style={inputStyle}
              />
            )}
            {authType === "api_key" && (
              <input
                value={apiKeyHeader}
                onChange={(e) => setApiKeyHeader(e.target.value)}
                placeholder="Header 名（默认 X-API-Key）"
                className={monoInputCls}
                style={inputStyle}
              />
            )}
          </>
        )}

        {type === "mcp" && (
          <input
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder="https://mcp-proxy.internal/mcp（streamable HTTP）"
            className={monoInputCls}
            style={inputStyle}
          />
        )}
      </div>

      {(type === "api" || type === "mcp") && (
        <textarea
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={2}
          spellCheck={false}
          placeholder={"自定义 Header（可选，每行一条）\nX-Tenant-Id: demo"}
          className={cn(monoInputCls, "mt-3 w-full resize-y")}
          style={inputStyle}
        />
      )}

      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{error}</p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="flex items-center gap-1.5 rounded-[8px] px-4 py-1.5 text-xs font-medium disabled:opacity-50"
          style={{ background: "var(--purple)", color: "#fff" }}
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          {submitting ? "创建中..." : "创建"}
        </button>
        <button
          onClick={onCreated}
          className="rounded-[8px] border px-4 py-1.5 text-xs"
          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
        >
          取消
        </button>
      </div>
      <p className="mt-2 flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
        <Shield size={11} />
        {type === "bi" && "仅支持只读访问：所有查询经 SELECT-ONLY 校验 + READ ONLY 事务 + 超时与行数硬限制"}
        {type === "api" && "只读原则：REST 仅允许 GET/POST，GraphQL 禁止 mutation/subscription；凭证仅存服务端不回显"}
        {type === "mcp" && "经内部 MCP 代理访问第三方 MCP 服务（streamable HTTP，自动回退 SSE），每次调用独立建连"}
      </p>
    </section>
  );
}

// ─── API 数据源调试台 ─────────────────────────────────────────────────────────

interface GraphQLFieldItem {
  name: string;
  description: string;
  args: Array<{ name: string; type: string }>;
  returnType: string;
}

/** api 数据源面板：REST 请求台 / GraphQL 查询台 + Schema 浏览 */
function ApiSourcePanel({ source }: { source: DataSourceItem }) {
  const isGraphQL = source.meta?.protocol === "graphql";

  // REST
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  const [path, setPath] = useState("");
  const [paramsText, setParamsText] = useState("");
  const [bodyText, setBodyText] = useState("");
  // GraphQL
  const [query, setQuery] = useState("{\n  __typename\n}");
  const [variablesText, setVariablesText] = useState("");
  const [schemaFields, setSchemaFields] = useState<GraphQLFieldItem[] | null>(null);
  const [loadingFields, setLoadingFields] = useState(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [resultMeta, setResultMeta] = useState("");

  const run = useCallback(async () => {
    setRunning(true);
    setError("");
    setResult(null);
    setResultMeta("");
    try {
      let payload: Record<string, unknown>;
      let action: string;
      if (isGraphQL) {
        action = "graphql";
        payload = { query };
        if (variablesText.trim()) {
          try {
            payload.variables = JSON.parse(variablesText);
          } catch {
            throw new Error("variables 不是合法 JSON");
          }
        }
      } else {
        action = "request";
        payload = { method, path: path.trim() || undefined };
        if (paramsText.trim()) {
          try {
            payload.params = JSON.parse(paramsText);
          } catch {
            throw new Error("params 不是合法 JSON");
          }
        }
        if (method === "POST" && bodyText.trim()) {
          try {
            payload.body = JSON.parse(bodyText);
          } catch {
            throw new Error("body 不是合法 JSON");
          }
        }
      }
      const res = await fetch(`/api/v1/datasources/${source.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? "请求失败");
        return;
      }
      const d = json.data;
      if (isGraphQL) {
        setResult(d.errors?.length ? { data: d.data, errors: d.errors } : d.data);
        setResultMeta(`${d.elapsedMs}ms${d.truncated ? " · 已截断" : ""}`);
      } else {
        setResult(d.body);
        setResultMeta(`HTTP ${d.status} · ${d.elapsedMs}ms${d.truncated ? " · 已截断" : ""}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setRunning(false);
    }
  }, [source.id, isGraphQL, query, variablesText, method, path, paramsText, bodyText]);

  const loadSchema = useCallback(async () => {
    if (schemaFields) {
      setSchemaFields(null);
      return;
    }
    setLoadingFields(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/datasources/${source.id}/schema`);
      const json = await res.json();
      if (json.ok) setSchemaFields(json.data.fields ?? []);
      else setError(json.error?.message ?? "Schema 内省失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setLoadingFields(false);
    }
  }, [source.id, schemaFields]);

  /** 点击 Schema 字段 → 插入查询骨架 */
  const insertField = useCallback((field: GraphQLFieldItem) => {
    const argsPart = field.args.length > 0
      ? `(${field.args.map((a) => `${a.name}: ${a.type.includes("String") ? '""' : "null"}`).join(", ")})`
      : "";
    setQuery(`{\n  ${field.name}${argsPart} {\n    __typename\n  }\n}`);
  }, []);

  return (
    <section
      className="rounded-[var(--radius-sm)] border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
          <Webhook size={15} style={{ color: "var(--purple)" }} />
          {isGraphQL ? "GraphQL 查询台" : "REST 请求台"}
        </h2>
        {isGraphQL && (
          <button
            onClick={loadSchema}
            disabled={loadingFields}
            className="flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {loadingFields ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
            {schemaFields ? "收起 Schema" : "浏览 Schema"}
          </button>
        )}
      </div>

      {isGraphQL && schemaFields && (
        <div
          className="mt-3 max-h-64 overflow-auto rounded-[8px] border"
          style={{ borderColor: "var(--line)", background: "var(--paper)" }}
        >
          {schemaFields.length === 0 && (
            <p className="p-3 text-xs" style={{ color: "var(--muted)" }}>未发现 Query 根字段</p>
          )}
          {schemaFields.map((f) => (
            <button
              key={f.name}
              onClick={() => insertField(f)}
              className="block w-full border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--purple-pale)]"
              style={{ borderColor: "var(--line)" }}
              title="点击插入查询骨架"
            >
              <span className="font-mono font-semibold" style={{ color: "var(--ink)" }}>
                {f.name}
                {f.args.length > 0 && `(${f.args.map((a) => `${a.name}: ${a.type}`).join(", ")})`}
              </span>
              <span className="ml-1.5 font-mono" style={{ color: "var(--purple)" }}>→ {f.returnType}</span>
              {f.description && (
                <span className="ml-2" style={{ color: "var(--muted)" }}>{f.description}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {isGraphQL ? (
        <div className="mt-3 grid gap-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={6}
            spellCheck={false}
            className={cn(monoInputCls, "w-full resize-y")}
            style={inputStyle}
          />
          <textarea
            value={variablesText}
            onChange={(e) => setVariablesText(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder='variables JSON（可选），如 {"code": "CN"}'
            className={cn(monoInputCls, "w-full resize-y")}
            style={inputStyle}
          />
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          <div className="flex gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as "GET" | "POST")}
              className={inputCls}
              style={inputStyle}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="相对路径（如 /v1/users），留空请求 endpoint 本身"
              className={cn(monoInputCls, "flex-1")}
              style={inputStyle}
            />
          </div>
          <textarea
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder='query 参数 JSON（可选），如 {"page": "1"}'
            className={cn(monoInputCls, "w-full resize-y")}
            style={inputStyle}
          />
          {method === "POST" && (
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder="请求体 JSON（可选）"
              className={cn(monoInputCls, "w-full resize-y")}
              style={inputStyle}
            />
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 rounded-[8px] px-4 py-1.5 text-xs font-medium disabled:opacity-50"
          style={{ background: "var(--purple)", color: "#fff" }}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? "请求中..." : isGraphQL ? "执行查询" : "发送请求"}
        </button>
        {resultMeta && <span className="text-xs" style={{ color: "var(--muted)" }}>{resultMeta}</span>}
      </div>

      {error && (
        <p className="mt-3 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {result !== null && <JsonView value={result} />}
    </section>
  );
}

// ─── MCP 数据源调试台 ─────────────────────────────────────────────────────────

interface McpToolItem {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface McpStepItem {
  tool: string;
  input: unknown;
  output: string;
  elapsedMs: number;
}

/** mcp 数据源面板：工具列表 + 单工具调用 + ReAct Agent 调试 */
function McpSourcePanel({ source }: { source: DataSourceItem }) {
  const [tools, setTools] = useState<McpToolItem[] | null>(null);
  const [loadingTools, setLoadingTools] = useState(true);
  const [toolsError, setToolsError] = useState("");
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  // 单工具调用
  const [toolName, setToolName] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [invoking, setInvoking] = useState(false);
  const [invokeError, setInvokeError] = useState("");
  const [invokeResult, setInvokeResult] = useState<{ result: string; elapsedMs: number; truncated: boolean } | null>(null);

  // ReAct Agent
  const [task, setTask] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentResult, setAgentResult] = useState<{ answer: string; steps: McpStepItem[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/datasources/${source.id}/tools`);
        const json = await res.json();
        if (cancelled) return;
        if (json.ok) setTools(json.data.tools ?? []);
        else setToolsError(json.error?.message ?? "工具列表获取失败");
      } catch (err) {
        if (!cancelled) setToolsError(err instanceof Error ? err.message : "网络异常");
      } finally {
        if (!cancelled) setLoadingTools(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  const invoke = useCallback(async () => {
    if (!toolName.trim()) {
      setInvokeError("请先选择或输入工具名");
      return;
    }
    let args: Record<string, unknown> = {};
    if (argsText.trim()) {
      try {
        args = JSON.parse(argsText);
      } catch {
        setInvokeError("args 不是合法 JSON");
        return;
      }
    }
    setInvoking(true);
    setInvokeError("");
    setInvokeResult(null);
    try {
      const res = await fetch(`/api/v1/datasources/${source.id}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: toolName.trim(), args }),
      });
      const json = await res.json();
      if (json.ok) setInvokeResult(json.data);
      else setInvokeError(json.error?.message ?? "调用失败");
    } catch (err) {
      setInvokeError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setInvoking(false);
    }
  }, [source.id, toolName, argsText]);

  const runAgent = useCallback(async () => {
    if (!task.trim()) {
      setAgentError("请输入任务描述");
      return;
    }
    setAgentRunning(true);
    setAgentError("");
    setAgentResult(null);
    try {
      const res = await fetch(`/api/v1/datasources/${source.id}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: task.trim() }),
      });
      const json = await res.json();
      if (json.ok) setAgentResult(json.data);
      else setAgentError(json.error?.message ?? "执行失败");
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setAgentRunning(false);
    }
  }, [source.id, task]);

  return (
    <>
      {/* 工具列表 */}
      <section
        className="rounded-[var(--radius-sm)] border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
          <Wrench size={15} style={{ color: "var(--purple)" }} />
          MCP 工具
          {tools && (
            <span className="font-normal" style={{ color: "var(--muted)" }}>（{tools.length} 个）</span>
          )}
        </h2>
        {loadingTools && (
          <p className="mt-3 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            <Loader2 size={13} className="animate-spin" /> 正在连接 MCP 代理...
          </p>
        )}
        {toolsError && (
          <p className="mt-3 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
            连接失败：{toolsError}
          </p>
        )}
        {tools && tools.length === 0 && (
          <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>代理未暴露任何工具</p>
        )}
        {tools && tools.length > 0 && (
          <div className="mt-3 max-h-72 overflow-auto rounded-[8px] border" style={{ borderColor: "var(--line)" }}>
            {tools.map((t) => (
              <div key={t.name} className="border-b last:border-b-0" style={{ borderColor: "var(--line)" }}>
                <button
                  onClick={() => setExpandedTool(expandedTool === t.name ? null : t.name)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--purple-pale)]"
                >
                  {expandedTool === t.name ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="font-mono font-semibold" style={{ color: "var(--ink)" }}>{t.name}</span>
                  <span className="truncate" style={{ color: "var(--muted)" }}>{t.description}</span>
                </button>
                {expandedTool === t.name && (
                  <div className="px-3 pb-3">
                    {t.description && (
                      <p className="text-xs" style={{ color: "var(--muted)" }}>{t.description}</p>
                    )}
                    <JsonView value={t.inputSchema} maxHeight={160} />
                    <button
                      onClick={() => {
                        setToolName(t.name);
                        setArgsText("{}");
                      }}
                      className="mt-2 rounded-[8px] border px-3 py-1 text-xs"
                      style={{ borderColor: "var(--purple)", color: "var(--purple)" }}
                    >
                      填入调用表单
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 单工具调用 */}
        <div className="mt-4 grid gap-2">
          <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>单工具调用</p>
          <div className="flex gap-2">
            <input
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="工具名（点击上方工具可自动填入）"
              className={cn(monoInputCls, "flex-1")}
              style={inputStyle}
            />
            <button
              onClick={invoke}
              disabled={invoking}
              className="flex items-center gap-1.5 rounded-[8px] px-4 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: "var(--purple)", color: "#fff" }}
            >
              {invoking ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {invoking ? "调用中..." : "调用"}
            </button>
          </div>
          <textarea
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder='参数 JSON，如 {"city": "hangzhou"}'
            className={cn(monoInputCls, "w-full resize-y")}
            style={inputStyle}
          />
          {invokeError && (
            <p className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
              {invokeError}
            </p>
          )}
          {invokeResult && (
            <div>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {invokeResult.elapsedMs}ms{invokeResult.truncated ? " · 已截断" : ""}
              </p>
              <JsonView value={tryParseJson(invokeResult.result)} />
            </div>
          )}
        </div>
      </section>

      {/* ReAct Agent 调试 */}
      <section
        className="rounded-[var(--radius-sm)] border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
          <Sparkles size={15} style={{ color: "var(--purple)" }} />
          ReAct Agent 调试
        </h2>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          输入自然语言任务，LLM 自主规划并调用 MCP 工具完成（LangGraph createReactAgent）
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !agentRunning && runAgent()}
            placeholder="如：查询杭州明天的天气并总结"
            className={cn(inputCls, "flex-1")}
            style={inputStyle}
          />
          <button
            onClick={runAgent}
            disabled={agentRunning}
            className="flex items-center gap-1.5 rounded-[8px] px-4 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--purple)", color: "#fff" }}
          >
            {agentRunning ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
            {agentRunning ? "执行中..." : "执行任务"}
          </button>
        </div>
        {agentError && (
          <p className="mt-3 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
            {agentError}
          </p>
        )}
        {agentResult && (
          <div className="mt-3">
            {agentResult.steps.length > 0 && (
              <div className="rounded-[8px] border" style={{ borderColor: "var(--line)" }}>
                {agentResult.steps.map((step, i) => (
                  <div
                    key={i}
                    className="border-b px-3 py-2 last:border-b-0"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <p className="flex items-center gap-2 text-xs">
                      <CheckCircle2 size={12} style={{ color: "var(--success, #16a34a)" }} />
                      <span className="font-mono font-semibold" style={{ color: "var(--ink)" }}>
                        {i + 1}. {step.tool}
                      </span>
                      <span style={{ color: "var(--muted)" }}>{step.elapsedMs}ms</span>
                    </p>
                    <p className="mt-1 truncate font-mono text-xs" style={{ color: "var(--muted)" }}>
                      入参：{JSON.stringify(step.input)?.slice(0, 200) ?? "null"}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs" style={{ color: "var(--muted)" }}>
                      结果：{step.output.slice(0, 200)}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div
              className="mt-3 whitespace-pre-wrap rounded-[8px] border p-3 text-sm leading-relaxed"
              style={{ borderColor: "var(--purple)", background: "var(--purple-pale)", color: "var(--ink)" }}
            >
              {agentResult.answer || "（Agent 未返回文本回答）"}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/** 尝试把字符串解析为 JSON（便于格式化展示），失败时原样返回 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
