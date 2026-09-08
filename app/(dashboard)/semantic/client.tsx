"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Layers, Loader2, Gauge, Tags, Play, CircleDot, Database, Plus, Pencil, Trash2, X, Save,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";
import { DataTable } from "@/components/data/DataTable";

/**
 * 语义层管理（design.md 6.4.2 / 4.1.3）
 * 语义模型浏览/新建/编辑/删除（维度/指标定义）+ SemanticQueryV1 → SQL 转译试运行
 * 内置模型只读，自定义模型持久化于 cause.semantic_models
 */

interface MetricField {
  id: string;
  name: string;
  column: string;
  agg: string;
  unit?: string;
  description: string;
}

interface DimensionField {
  id: string;
  name: string;
  column: string;
  values?: string[];
  description: string;
}

interface SemanticModelItem {
  id: string;
  name: string;
  schema: string;
  table: string;
  timeColumn: string;
  description: string;
  metricCount: number;
  dimensionCount: number;
  metrics: MetricField[];
  dimensions: DimensionField[];
  builtin: boolean;
  dataSourceId?: string;
  dataSourceName?: string;
  updatedAt?: string | null;
}

interface DataSourceOption {
  id: string;
  name: string;
  type: string;
  builtin: boolean;
}

interface TranslateResult {
  sql: string;
  model: { id: string; name: string };
  notes: string[];
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

export function SemanticClient() {
  const [models, setModels] = useState<SemanticModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 编辑器状态：null=关闭；model=null 表示新建
  const [editor, setEditor] = useState<{ model: SemanticModelItem | null } | null>(null);
  const [dataSources, setDataSources] = useState<DataSourceOption[]>([]);

  // 语义查询试运行表单
  const [metric, setMetric] = useState("gmv");
  const [dimension, setDimension] = useState("region");
  const [granularity, setGranularity] = useState("");
  const [from, setFrom] = useState("2026-01-01");
  const [to, setTo] = useState("2026-08-31");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [error, setError] = useState("");

  const selected = models.find((m) => m.id === selectedId) ?? null;
  const primaryModel = selected ?? models[0] ?? null;

  const loadModels = useCallback(async (keepSelection = false) => {
    try {
      const json = await apiFetch("/api/v1/semantic/models");
      if (json.ok) {
        const list: SemanticModelItem[] = json.data.models ?? [];
        setModels(list);
        setSelectedId((prev) => {
          if (keepSelection && prev && list.some((m) => m.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
        if (list[0]?.metrics[0]) setMetric(list[0].metrics[0].id);
        if (list[0]?.dimensions[0]) setDimension(list[0].dimensions[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDataSources = useCallback(async () => {
    try {
      const json = await apiFetch("/api/v1/datasources");
      if (json.ok) {
        // 语义模型仅支持 PostgreSQL（bi）数据源
        setDataSources(
          (json.data.dataSources ?? []).filter((s: DataSourceOption) => s.type === "bi"),
        );
      }
    } catch {
      // 数据源列表加载失败时编辑器仅可使用内置演示库
    }
  }, []);

  useEffect(() => {
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => {
      void loadModels();
      void loadDataSources();
    });
  }, [loadModels, loadDataSources]);

  /** 选中模型变化时重置表单选项 */
  useEffect(() => {
    if (!primaryModel) return;
    let cancelled = false;
    // 微任务延迟，避免 effect 内同步 setState
    Promise.resolve().then(() => {
      if (cancelled) return;
      setMetric(primaryModel.metrics[0]?.id ?? "gmv");
      setDimension(primaryModel.dimensions[0]?.id ?? "region");
      setGranularity("");
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, primaryModel]);

  /** 语义查询试运行：SemanticQueryV1 → SQL → 执行 */
  const runTranslate = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        intent: dimension === "stat_date" ? "trend" : "query",
        metrics: [{ metricId: metric }],
        dimensions: dimension
          ? [
              dimension === "stat_date" && granularity
                ? { dimensionId: "stat_date", granularity }
                : { dimensionId: dimension },
            ]
          : [],
        timeRange: from || to ? { from: from || undefined, to: to || undefined } : {},
        limit: 200,
      };
      const json = await apiFetch("/api/v1/semantic/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (json.ok) setResult(json.data);
      else setError(json.error?.message ?? "转译失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setRunning(false);
    }
  }, [metric, dimension, granularity, from, to, running]);

  /** 删除自定义模型 */
  const deleteModel = useCallback(async (m: SemanticModelItem) => {
    if (!window.confirm(`确认删除语义模型「${m.name}」？删除后不可恢复。`)) return;
    try {
      const json = await apiFetch(`/api/v1/semantic/models/${m.id}`, { method: "DELETE" });
      if (!json.ok) {
        window.alert(json.error?.message ?? "删除失败");
        return;
      }
      if (selectedId === m.id) setSelectedId(null);
      await loadModels();
    } catch {
      window.alert("网络异常，删除失败");
    }
  }, [selectedId, loadModels]);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>语义层管理</h1>
          <p className="mt-0.5 text-sm" style={{ color: "var(--muted)" }}>
            业务语义模型（维度/指标口径）统一管理，自然语言查询经语义层转译为安全 SQL
          </p>
        </div>
        {!editor && (
          <button
            onClick={() => setEditor({ model: null })}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] px-4 text-xs font-medium transition-transform hover:-translate-y-0.5"
            style={{ background: "var(--purple)", color: "#fff" }}
          >
            <Plus size={13} />
            新建模型
          </button>
        )}
      </header>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 size={24} className="animate-spin" style={{ color: "var(--purple)" }} />
        </div>
      ) : editor ? (
        <ModelEditor
          model={editor.model}
          dataSources={dataSources}
          onCancel={() => setEditor(null)}
          onSaved={async (id) => {
            setEditor(null);
            await loadModels(true);
            if (id) setSelectedId(id);
          }}
        />
      ) : (
        <div className="flex gap-5">
          {/* ── 模型列表 ── */}
          <aside className="w-72 shrink-0 space-y-3">
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                className="w-full rounded-[var(--radius-sm)] border p-4 text-left transition-all hover:-translate-y-0.5"
                style={{
                  borderColor: selectedId === m.id ? "var(--purple)" : "var(--line)",
                  background: "var(--surface)",
                  boxShadow: selectedId === m.id ? "0 0 0 3px var(--purple-pale)" : undefined,
                }}
              >
                <div className="flex items-center gap-2">
                  <Layers size={15} style={{ color: "var(--purple)" }} />
                  <span className="flex-1 truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {m.name}
                  </span>
                  {m.builtin ? (
                    <span className="rounded-full px-1.5 py-px text-xs" style={{ background: "var(--purple-pale)", color: "var(--purple)" }}>
                      内置
                    </span>
                  ) : (
                    <span className="rounded-full px-1.5 py-px text-xs" style={{ background: "var(--success-pale)", color: "var(--success)" }}>
                      自定义
                    </span>
                  )}
                </div>
                <p className="mt-1 font-mono text-xs" style={{ color: "var(--muted)" }}>
                  {m.schema}.{m.table}
                </p>
                <div className="mt-2 flex gap-3 text-xs" style={{ color: "var(--muted)" }}>
                  <span className="flex items-center gap-1">
                    <Gauge size={11} style={{ color: "var(--purple)" }} />
                    {m.metricCount} 指标
                  </span>
                  <span className="flex items-center gap-1">
                    <Tags size={11} style={{ color: "var(--success)" }} />
                    {m.dimensionCount} 维度
                  </span>
                </div>
              </button>
            ))}
          </aside>

          {/* ── 模型详情 + 试运行 ── */}
          <div className="min-w-0 flex-1 space-y-5">
            {primaryModel && (
              <>
                {/* 模型定义 */}
                <section
                  className="rounded-[var(--radius-sm)] border p-5"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                      <Database size={15} style={{ color: "var(--purple)" }} />
                      {primaryModel.name}
                    </h2>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                        {primaryModel.schema}.{primaryModel.table} · 时间列 {primaryModel.timeColumn}
                        {primaryModel.dataSourceName ? ` · ${primaryModel.dataSourceName}` : ""}
                      </span>
                      {!primaryModel.builtin && (
                        <>
                          <button
                            onClick={() => setEditor({ model: primaryModel })}
                            title="编辑模型"
                            className="flex h-7 w-7 items-center justify-center rounded-[6px] border transition-colors hover:border-[var(--purple)]"
                            style={{ borderColor: "var(--line)", color: "var(--purple)" }}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => void deleteModel(primaryModel)}
                            title="删除模型"
                            className="flex h-7 w-7 items-center justify-center rounded-[6px] border transition-colors hover:border-[var(--danger)]"
                            style={{ borderColor: "var(--line)", color: "var(--danger)" }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    {primaryModel.description}
                    {primaryModel.builtin ? "（内置模型只读，如需修改请新建自定义模型）" : ""}
                  </p>

                  <div className="mt-4 grid grid-cols-2 gap-5">
                    {/* 指标定义 */}
                    <div>
                      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold" style={{ color: "var(--purple)" }}>
                        <Gauge size={12} /> 指标（{primaryModel.metrics.length}）
                      </h3>
                      <ul className="space-y-1.5">
                        {primaryModel.metrics.map((m) => (
                          <li
                            key={m.id}
                            className="rounded-[8px] border px-3 py-1.5 text-xs"
                            style={{ borderColor: "var(--line)" }}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold" style={{ color: "var(--ink)" }}>{m.name}</span>
                              <code className="rounded px-1" style={{ background: "var(--purple-pale)", color: "var(--purple)" }}>
                                {m.agg}({m.column})
                              </code>
                              {m.unit && <span style={{ color: "var(--muted)" }}>单位：{m.unit}</span>}
                            </div>
                            <p className="mt-0.5" style={{ color: "var(--muted)" }}>{m.description}</p>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* 维度定义 */}
                    <div>
                      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold" style={{ color: "var(--success)" }}>
                        <Tags size={12} /> 维度（{primaryModel.dimensions.length}）
                      </h3>
                      <ul className="space-y-1.5">
                        {primaryModel.dimensions.map((d) => (
                          <li
                            key={d.id}
                            className="rounded-[8px] border px-3 py-1.5 text-xs"
                            style={{ borderColor: "var(--line)" }}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold" style={{ color: "var(--ink)" }}>{d.name}</span>
                              <code className="rounded px-1" style={{ background: "var(--success-pale)", color: "var(--success)" }}>
                                {d.column}
                              </code>
                            </div>
                            <p className="mt-0.5" style={{ color: "var(--muted)" }}>
                              {d.description}
                              {d.values && d.values.length > 0 ? ` · 取值：${d.values.slice(0, 5).join("、")}${d.values.length > 5 ? " 等" : ""}` : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </section>

                {/* 语义查询试运行 */}
                <section
                  className="rounded-[var(--radius-sm)] border p-5"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                >
                  <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                    <Play size={15} style={{ color: "var(--purple)" }} />
                    语义查询试运行
                    <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>
                      SemanticQueryV1 → SQL 转译 → 只读执行
                    </span>
                  </h2>

                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Field label="指标">
                      <select value={metric} onChange={(e) => setMetric(e.target.value)} className={selectCls} style={controlStyle}>
                        {primaryModel.metrics.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}（{m.id}）</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="分组维度">
                      <select value={dimension} onChange={(e) => setDimension(e.target.value)} className={selectCls} style={controlStyle}>
                        {primaryModel.dimensions.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}（{d.id}）</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="时间粒度">
                      <select value={granularity} onChange={(e) => setGranularity(e.target.value)} className={selectCls} style={controlStyle}>
                        <option value="">原始粒度</option>
                        <option value="day">按日</option>
                        <option value="week">按周</option>
                        <option value="month">按月</option>
                        <option value="quarter">按季度</option>
                      </select>
                    </Field>
                    <Field label="开始日期">
                      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={cn(selectCls, "w-36")} style={controlStyle} />
                    </Field>
                    <Field label="结束日期">
                      <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={cn(selectCls, "w-36")} style={controlStyle} />
                    </Field>
                    <button
                      onClick={runTranslate}
                      disabled={running}
                      className="flex h-9 items-center gap-1.5 rounded-[8px] px-4 text-xs font-medium transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                      style={{ background: "var(--purple)", color: "#fff" }}
                    >
                      {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      {running ? "执行中..." : "转译并执行"}
                    </button>
                  </div>

                  {error && (
                    <p className="mt-3 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                      {error}
                    </p>
                  )}

                  {result && (
                    <div className="mt-4 space-y-3">
                      <div>
                        <p className="mb-1 flex items-center gap-1.5 text-xs" style={{ color: "var(--muted)" }}>
                          <CircleDot size={11} style={{ color: "var(--success)" }} />
                          命中模型「{result.model.name}」· {result.rowCount} 行 · {result.elapsedMs}ms
                        </p>
                        <pre
                          className="overflow-x-auto rounded-[8px] p-3 font-mono text-xs"
                          style={{ background: "var(--purple-pale)", color: "var(--ink)" }}
                        >
                          {result.sql}
                        </pre>
                        {result.notes.length > 0 && (
                          <p className="mt-1 text-xs" style={{ color: "var(--warning)" }}>
                            转译说明：{result.notes.join("；")}
                          </p>
                        )}
                      </div>
                      <DataTable columns={result.columns} rows={result.rows} defaultOpen maxHeight={320} />
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 模型编辑器（新建 / 编辑） ─────────────────────────────────────────────────

interface MetricDraft {
  uid: string;
  id: string;
  name: string;
  column: string;
  agg: string;
  unit: string;
  description: string;
}

interface DimensionDraft {
  uid: string;
  id: string;
  name: string;
  column: string;
  valuesText: string;
  description: string;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 草稿行 uid 序列：为可增删/可编辑的指标·维度行生成稳定 key，避免用数组索引 */
let draftUidSeq = 0;
const nextDraftUid = () => `draft-${++draftUidSeq}`;

function ModelEditor({
  model,
  dataSources,
  onCancel,
  onSaved,
}: {
  model: SemanticModelItem | null;
  dataSources: DataSourceOption[];
  onCancel: () => void;
  onSaved: (id: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(model?.name ?? "");
  const [schemaName, setSchemaName] = useState(model?.schema ?? "data");
  const [table, setTable] = useState(model?.table ?? "");
  const [timeColumn, setTimeColumn] = useState(model?.timeColumn ?? "");
  const [description, setDescription] = useState(model?.description ?? "");
  const [dataSourceId, setDataSourceId] = useState(model?.dataSourceId ?? "data_source_demo_pg");
  const [metrics, setMetrics] = useState<MetricDraft[]>(
    () => model?.metrics.map((m) => ({ ...m, unit: m.unit ?? "", uid: nextDraftUid() })) ?? [emptyMetric()],
  );
  const [dimensions, setDimensions] = useState<DimensionDraft[]>(
    () => model?.dimensions.map((d) => ({
      uid: nextDraftUid(), id: d.id, name: d.name, column: d.column,
      valuesText: d.values?.join(",") ?? "", description: d.description,
    })) ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** 前端基础校验（服务端仍会二次校验） */
  const validate = (): string => {
    if (!name.trim()) return "请填写模型名称";
    if (!IDENT_RE.test(schemaName)) return "schema 仅允许字母/数字/下划线";
    if (!IDENT_RE.test(table)) return "表名仅允许字母/数字/下划线";
    if (timeColumn && !IDENT_RE.test(timeColumn)) return "时间列仅允许字母/数字/下划线";
    if (metrics.length === 0) return "至少定义一个指标";
    const ids = new Set<string>();
    for (const m of metrics) {
      if (!m.id.trim() || !m.name.trim() || !m.column.trim()) return "指标 id/名称/列名不能为空";
      if (!IDENT_RE.test(m.id) || !IDENT_RE.test(m.column)) return `指标 ${m.id} 的 id/列名仅允许字母/数字/下划线`;
      if (ids.has(m.id)) return `字段 id 重复：${m.id}`;
      ids.add(m.id);
    }
    for (const d of dimensions) {
      if (!d.id.trim() || !d.name.trim() || !d.column.trim()) return "维度 id/名称/列名不能为空";
      if (!IDENT_RE.test(d.id) || !IDENT_RE.test(d.column)) return `维度 ${d.id} 的 id/列名仅允许字母/数字/下划线`;
      if (ids.has(d.id)) return `字段 id 重复：${d.id}`;
      ids.add(d.id);
    }
    return "";
  };

  const save = async () => {
    const msg = validate();
    if (msg) {
      setError(msg);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = {
        name: name.trim(),
        dataSourceId,
        tableRef: `${schemaName.trim()}.${table.trim()}`,
        timeColumn: timeColumn.trim() || undefined,
        description: description.trim(),
        metrics: metrics.map((m) => ({
          id: m.id.trim(), name: m.name.trim(), column: m.column.trim(),
          agg: m.agg, unit: m.unit.trim() || undefined, description: m.description.trim(),
        })),
        dimensions: dimensions.map((d) => ({
          id: d.id.trim(), name: d.name.trim(), column: d.column.trim(),
          values: d.valuesText.trim()
            ? d.valuesText.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
            : undefined,
          description: d.description.trim(),
        })),
      };
      const json = await apiFetch(
        model ? `/api/v1/semantic/models/${model.id}` : "/api/v1/semantic/models",
        {
          method: model ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!json.ok) {
        setError(json.error?.message ?? "保存失败");
        return;
      }
      await onSaved(json.data.id ?? model?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setSaving(false);
    }
  };

  const updateMetric = (i: number, patch: Partial<MetricDraft>) =>
    setMetrics((list) => list.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  const updateDimension = (i: number, patch: Partial<DimensionDraft>) =>
    setDimensions((list) => list.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  return (
    <section
      className="rounded-[var(--radius-sm)] border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
          <Database size={15} style={{ color: "var(--purple)" }} />
          {model ? `编辑模型：${model.name}` : "新建语义模型"}
        </h2>
        <button
          onClick={onCancel}
          title="取消"
          className="flex h-7 w-7 items-center justify-center rounded-[6px] border"
          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
        >
          <X size={12} />
        </button>
      </div>

      {/* 基础信息 */}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Field label="模型名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：售后工单明细" className={cn(selectCls, "w-full")} style={controlStyle} />
        </Field>
        <Field label="Schema">
          <input value={schemaName} onChange={(e) => setSchemaName(e.target.value)} placeholder="data" className={cn(selectCls, "w-full font-mono")} style={controlStyle} />
        </Field>
        <Field label="表名">
          <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="daily_metrics" className={cn(selectCls, "w-full font-mono")} style={controlStyle} />
        </Field>
        <Field label="数据源（PostgreSQL）">
          <select value={dataSourceId} onChange={(e) => setDataSourceId(e.target.value)} className={cn(selectCls, "w-full")} style={controlStyle}>
            {dataSources.length > 0 ? (
              dataSources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.builtin ? "（内置）" : ""}</option>
              ))
            ) : (
              <option value="data_source_demo_pg">演示经营库（PostgreSQL）（内置）</option>
            )}
          </select>
        </Field>
        <Field label="时间列（可选）">
          <input value={timeColumn} onChange={(e) => setTimeColumn(e.target.value)} placeholder="stat_date" className={cn(selectCls, "w-full font-mono")} style={controlStyle} />
        </Field>
        <Field label="模型描述">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="业务口径说明" className={cn(selectCls, "w-full")} style={controlStyle} />
        </Field>
      </div>

      {/* 指标定义 */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-bold" style={{ color: "var(--purple)" }}>
            <Gauge size={12} /> 指标（{metrics.length}）
          </h3>
          <button
            onClick={() => setMetrics((list) => [...list, emptyMetric()])}
            className="flex items-center gap-1 rounded-[6px] border px-2 py-1 text-xs"
            style={{ borderColor: "var(--line)", color: "var(--purple)" }}
          >
            <Plus size={11} /> 添加指标
          </button>
        </div>
        <div className="space-y-2">
          {metrics.map((m, i) => (
            <div key={m.uid} className="flex items-center gap-2 rounded-[8px] border p-2" style={{ borderColor: "var(--line)" }}>
              <input value={m.id} onChange={(e) => updateMetric(i, { id: e.target.value })} placeholder="id（如 gmv）" className={cn(selectCls, "w-28 font-mono")} style={controlStyle} />
              <input value={m.name} onChange={(e) => updateMetric(i, { name: e.target.value })} placeholder="名称" className={cn(selectCls, "w-24")} style={controlStyle} />
              <input value={m.column} onChange={(e) => updateMetric(i, { column: e.target.value })} placeholder="物理列" className={cn(selectCls, "w-28 font-mono")} style={controlStyle} />
              <select value={m.agg} onChange={(e) => updateMetric(i, { agg: e.target.value })} className={cn(selectCls, "w-24")} style={controlStyle}>
                {["sum", "avg", "count", "max", "min", "none"].map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              <input value={m.unit} onChange={(e) => updateMetric(i, { unit: e.target.value })} placeholder="单位" className={cn(selectCls, "w-16")} style={controlStyle} />
              <input value={m.description} onChange={(e) => updateMetric(i, { description: e.target.value })} placeholder="口径描述" className={cn(selectCls, "min-w-0 flex-1")} style={controlStyle} />
              <button
                onClick={() => setMetrics((list) => list.filter((_, idx) => idx !== i))}
                disabled={metrics.length <= 1}
                title="移除指标"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] disabled:opacity-30"
                style={{ color: "var(--danger)" }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 维度定义 */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-bold" style={{ color: "var(--success)" }}>
            <Tags size={12} /> 维度（{dimensions.length}）
          </h3>
          <button
            onClick={() => setDimensions((list) => [...list, { uid: nextDraftUid(), id: "", name: "", column: "", valuesText: "", description: "" }])}
            className="flex items-center gap-1 rounded-[6px] border px-2 py-1 text-xs"
            style={{ borderColor: "var(--line)", color: "var(--success)" }}
          >
            <Plus size={11} /> 添加维度
          </button>
        </div>
        <div className="space-y-2">
          {dimensions.length === 0 && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>暂无维度，可不添加</p>
          )}
          {dimensions.map((d, i) => (
            <div key={d.uid} className="flex items-center gap-2 rounded-[8px] border p-2" style={{ borderColor: "var(--line)" }}>
              <input value={d.id} onChange={(e) => updateDimension(i, { id: e.target.value })} placeholder="id（如 region）" className={cn(selectCls, "w-28 font-mono")} style={controlStyle} />
              <input value={d.name} onChange={(e) => updateDimension(i, { name: e.target.value })} placeholder="名称" className={cn(selectCls, "w-24")} style={controlStyle} />
              <input value={d.column} onChange={(e) => updateDimension(i, { column: e.target.value })} placeholder="物理列" className={cn(selectCls, "w-28 font-mono")} style={controlStyle} />
              <input value={d.valuesText} onChange={(e) => updateDimension(i, { valuesText: e.target.value })} placeholder="枚举取值（逗号分隔，可选）" className={cn(selectCls, "w-44")} style={controlStyle} />
              <input value={d.description} onChange={(e) => updateDimension(i, { description: e.target.value })} placeholder="描述" className={cn(selectCls, "min-w-0 flex-1")} style={controlStyle} />
              <button
                onClick={() => setDimensions((list) => list.filter((_, idx) => idx !== i))}
                title="移除维度"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
                style={{ color: "var(--danger)" }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="h-9 rounded-[8px] border px-4 text-xs font-medium"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          取消
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="flex h-9 items-center gap-1.5 rounded-[8px] px-4 text-xs font-medium transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          style={{ background: "var(--purple)", color: "#fff" }}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {saving ? "保存中..." : model ? "保存修改" : "创建模型"}
        </button>
      </div>
    </section>
  );
}

function emptyMetric(): MetricDraft {
  return { uid: nextDraftUid(), id: "", name: "", column: "", agg: "sum", unit: "", description: "" };
}

const selectCls =
  "h-9 rounded-[8px] border px-2.5 text-xs outline-none focus:border-[var(--purple)]";

const controlStyle = {
  borderColor: "var(--line)",
  background: "var(--paper)",
  color: "var(--ink)",
} as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>{label}</span>
      {children}
    </label>
  );
}
