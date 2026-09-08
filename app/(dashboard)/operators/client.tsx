"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes, Database, FlaskConical, Play, Loader2, Terminal, Info,
  BarChart3, Telescope, CheckCircle2, XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";
import { DataTable } from "@/components/data/DataTable";

/**
 * 算子中心（design.md 5.2 算子层管理台）
 * 12 个预置算子（数据 6 + 研究 6）统一注册；
 * 基于算子参数 Schema 动态渲染试运行表单，真实执行并回显 SQL/结果/耗时。
 */

interface OperatorParam {
  name: string;
  label: string;
  type: "string" | "number" | "date" | "enum" | "boolean";
  required: boolean;
  defaultValue?: string | number | boolean;
  options?: string[];
  placeholder?: string;
}

interface OperatorItem {
  id: string;
  name: string;
  category: "data" | "research";
  description: string;
  engine: "sql" | "llm" | "hybrid";
  params: OperatorParam[];
}

interface RunResult {
  ok: boolean;
  operatorId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  sql?: string;
  elapsedMs: number;
  notes: string[];
  error?: string;
}

/** 长文本字段用 textarea 渲染（素材/正文类输入） */
const LONG_TEXT_FIELDS = new Set(["text", "material", "sources"]);

/** engine 徽章样式 */
function EngineBadge({ engine }: { engine: OperatorItem["engine"] }) {
  const meta = {
    sql: { label: "SQL 引擎", bg: "var(--purple-pale)", fg: "var(--purple)" },
    llm: { label: "LLM 引擎", bg: "var(--warning-pale)", fg: "var(--warning)" },
    hybrid: { label: "混合引擎", bg: "var(--success-pale)", fg: "var(--success)" },
  }[engine];
  return (
    <span className="rounded-full px-2 py-px text-xs font-medium" style={{ background: meta.bg, color: meta.fg }}>
      {meta.label}
    </span>
  );
}

const inputStyle = {
  borderColor: "var(--line)",
  background: "var(--paper)",
  color: "var(--ink)",
} as const;

export function OperatorsClient() {
  const [operators, setOperators] = useState<OperatorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 动态表单值（统一字符串存储，提交时按类型转换）
  const [form, setForm] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState("");

  const selected = operators.find((o) => o.id === selectedId) ?? null;
  const dataOps = operators.filter((o) => o.category === "data");
  const researchOps = operators.filter((o) => o.category === "research");

  const loadOperators = useCallback(async () => {
    try {
      const json = await apiFetch("/api/v1/operators");
      if (json.ok) {
        const list: OperatorItem[] = json.data.operators ?? [];
        setOperators(list);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(loadOperators);
  }, [loadOperators]);

  /** 选中算子变化时用 defaultValue 初始化表单 */
  useEffect(() => {
    if (!selected) return;
    const initial: Record<string, string> = {};
    for (const p of selected.params) {
      initial[p.name] = p.defaultValue !== undefined ? String(p.defaultValue) : "";
    }
    let cancelled = false;
    // 微任务延迟，避免 effect 内同步 setState
    Promise.resolve().then(() => {
      if (cancelled) return;
      setForm(initial);
      setResult(null);
      setError("");
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selected]);

  /** 表单输入更新 */
  const updateField = useCallback((name: string, value: string) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  }, []);

  /** 构造提交 input（按参数类型转换，空值剔除） */
  const buildInput = useCallback((): Record<string, string | number | boolean> => {
    const input: Record<string, string | number | boolean> = {};
    if (!selected) return input;
    for (const p of selected.params) {
      const raw = (form[p.name] ?? "").trim();
      if (raw === "") continue;
      if (p.type === "number") input[p.name] = Number(raw);
      else if (p.type === "boolean") input[p.name] = raw === "true";
      else input[p.name] = raw;
    }
    return input;
  }, [selected, form]);

  /** 校验必填项 */
  const missingRequired = useMemo(() => {
    if (!selected) return [];
    return selected.params.filter((p) => p.required && !(form[p.name] ?? "").trim());
  }, [selected, form]);

  /** 试运行 */
  const runTrial = useCallback(async () => {
    if (running) return;
    if (!selected) return;
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const json = await apiFetch("/api/v1/operators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: selected.id, input: buildInput() }),
      });
      if (json.ok) setResult(json.data);
      else setError(json.error?.message ?? "执行失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
    } finally {
      setRunning(false);
    }
  }, [selected, buildInput, running]);

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 size={24} className="animate-spin" style={{ color: "var(--purple)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-bold" style={{ color: "var(--ink)" }}>
          <Boxes size={19} style={{ color: "var(--purple)" }} />
          算子中心
        </h1>
        <p className="mt-0.5 text-sm" style={{ color: "var(--muted)" }}>
          数据分析算子（SQL 引擎）与研究算子（LLM 引擎）统一注册与管理，支持在线试运行与调试
          <span className="ml-2 font-semibold" style={{ color: "var(--purple)" }}>
            {operators.length} 个算子 · 数据 {dataOps.length} · 研究 {researchOps.length}
          </span>
        </p>
      </header>

      <div className="flex gap-5">
        {/* ── 算子列表（按分类分组） ── */}
        <aside className="w-64 shrink-0 space-y-4">
          <OperatorGroup
            title="数据分析算子"
            icon={<BarChart3 size={12} style={{ color: "var(--purple)" }} />}
            operators={dataOps}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <OperatorGroup
            title="深度研究算子"
            icon={<Telescope size={12} style={{ color: "var(--warning)" }} />}
            operators={researchOps}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>

        {/* ── 算子详情 + 试运行 ── */}
        <div className="min-w-0 flex-1 space-y-5">
          {selected && (
            <>
              {/* 算子说明 */}
              <section
                className="rounded-[var(--radius-sm)] border p-5"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                    {selected.name}
                  </h2>
                  <code className="rounded px-1.5 py-0.5 font-mono text-xs" style={{ background: "var(--purple-pale)", color: "var(--purple)" }}>
                    {selected.id}
                  </code>
                  <EngineBadge engine={selected.engine} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  {selected.description}
                </p>
              </section>

              {/* 参数表单（动态渲染） */}
              <section
                className="rounded-[var(--radius-sm)] border p-5"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <h3 className="mb-3 flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                  <FlaskConical size={14} style={{ color: "var(--purple)" }} />
                  试运行
                  <span className="font-normal" style={{ color: "var(--muted)" }}>输入参数后真实执行</span>
                </h3>

                <div className="grid grid-cols-2 gap-3">
                  {selected.params.map((p) => (
                    <div key={p.name} className={cn(LONG_TEXT_FIELDS.has(p.name) && "col-span-2")}>
                      <label className="mb-1 flex items-center gap-1 text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                        {p.label}
                        {p.required ? (
                          <span style={{ color: "var(--danger)" }}>*</span>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>（可选）</span>
                        )}
                      </label>

                      {p.type === "enum" ? (
                        <select
                          value={form[p.name] ?? ""}
                          onChange={(e) => updateField(p.name, e.target.value)}
                          className="w-full rounded-[8px] border px-3 py-2 text-sm outline-none focus:border-[var(--purple)]"
                          style={inputStyle}
                        >
                          {!p.required && <option value="">（不指定）</option>}
                          {(p.options ?? []).map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      ) : p.type === "boolean" ? (
                        <select
                          value={form[p.name] ?? "false"}
                          onChange={(e) => updateField(p.name, e.target.value)}
                          className="w-full rounded-[8px] border px-3 py-2 text-sm outline-none focus:border-[var(--purple)]"
                          style={inputStyle}
                        >
                          <option value="false">否</option>
                          <option value="true">是</option>
                        </select>
                      ) : LONG_TEXT_FIELDS.has(p.name) ? (
                        <textarea
                          value={form[p.name] ?? ""}
                          onChange={(e) => updateField(p.name, e.target.value)}
                          rows={5}
                          placeholder={p.placeholder ?? ""}
                          className="w-full resize-y rounded-[8px] border p-3 text-sm outline-none focus:border-[var(--purple)]"
                          style={inputStyle}
                        />
                      ) : (
                        <input
                          type={p.type === "date" ? "date" : p.type === "number" ? "number" : "text"}
                          value={form[p.name] ?? ""}
                          onChange={(e) => updateField(p.name, e.target.value)}
                          placeholder={p.placeholder ?? ""}
                          step={p.type === "number" ? "0.1" : undefined}
                          className="w-full rounded-[8px] border px-3 py-2 text-sm outline-none focus:border-[var(--purple)]"
                          style={inputStyle}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-center justify-between">
                  {missingRequired.length > 0 ? (
                    <p className="text-xs" style={{ color: "var(--danger)" }}>
                      待填必填项：{missingRequired.map((p) => p.label).join("、")}
                    </p>
                  ) : (
                    <p className="text-xs" style={{ color: "var(--muted)" }}>
                      {selected.engine === "llm" ? "LLM 引擎，执行需要数秒" : "SQL 引擎，只读执行"}
                    </p>
                  )}
                  <button
                    onClick={runTrial}
                    disabled={running || missingRequired.length > 0}
                    className="flex items-center gap-1.5 rounded-[8px] px-4 py-1.5 text-xs font-medium transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                    style={{ background: "var(--purple)", color: "#fff" }}
                  >
                    {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    {running ? "执行中..." : "执行算子"}
                  </button>
                </div>
              </section>

              {/* 执行结果 */}
              {error && (
                <p className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                  {error}
                </p>
              )}

              {result && <OperatorResult result={result} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** ── 分组算子列表 ── */
function OperatorGroup({
  title, icon, operators, selectedId, onSelect,
}: {
  title: string;
  icon: React.ReactNode;
  operators: OperatorItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (operators.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-bold" style={{ color: "var(--muted)" }}>
        {icon}
        {title}
        <span className="font-normal">（{operators.length}）</span>
      </h3>
      <ul className="space-y-1">
        {operators.map((op) => {
          const active = op.id === selectedId;
          return (
            <li key={op.id}>
              <button
                onClick={() => onSelect(op.id)}
                className={cn(
                  "w-full rounded-[8px] border px-3 py-2 text-left transition-all hover:-translate-y-0.5",
                )}
                style={{
                  borderColor: active ? "var(--purple)" : "var(--line)",
                  background: active ? "var(--purple-pale)" : "var(--surface)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    {op.name}
                  </span>
                  <code className="shrink-0 font-mono text-[10px]" style={{ color: "var(--muted)" }}>
                    {op.engine}
                  </code>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** ── 执行结果展示：状态条 + SQL + 表格/长文本 ── */
function OperatorResult({ result }: { result: RunResult }) {
  // 单列长文本结果（LLM 生成类算子）用整块文本视图
  const isTextResult =
    result.columns.length === 1 &&
    result.rows.length > 0 &&
    typeof Object.values(result.rows[0] ?? {})[0] === "string" &&
    String(Object.values(result.rows[0] ?? {})[0] ?? "").length > 160;

  return (
    <section
      className="rounded-[var(--radius-sm)] border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{
            background: result.ok ? "var(--success-pale)" : "var(--danger-pale)",
            color: result.ok ? "var(--success)" : "var(--danger)",
          }}
        >
          {result.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          {result.ok ? "执行成功" : "执行失败"}
        </span>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {result.rowCount} 行 · 耗时 {result.elapsedMs}ms
        </span>
      </div>

      {result.error && (
        <p className="mt-3 rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
          {result.error}
        </p>
      )}

      {result.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {result.notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5 text-xs" style={{ color: "var(--ink-soft)" }}>
              <Info size={11} className="mt-0.5 shrink-0" style={{ color: "var(--purple)" }} />
              {n}
            </li>
          ))}
        </ul>
      )}

      {result.sql && (
        <details className="mt-3 rounded-[8px] border" style={{ borderColor: "var(--line)" }}>
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-medium" style={{ color: "var(--purple)" }}>
            <Terminal size={12} />
            生成的 SQL（点击展开）
          </summary>
          <pre
            className="overflow-x-auto border-t px-3 py-2.5 font-mono text-[11px] leading-relaxed"
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
          >
            {result.sql}
          </pre>
        </details>
      )}

      {isTextResult ? (
        <pre
          className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-[8px] border p-4 text-xs leading-relaxed"
          style={{ borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink-soft)" }}
        >
          {String(Object.values(result.rows[0] ?? {})[0] ?? "")}
        </pre>
      ) : result.columns.length > 0 && result.rows.length > 0 ? (
        <div className="mt-3">
          <DataTable
            columns={result.columns}
            rows={result.rows}
            defaultOpen
            maxHeight={420}
          />
        </div>
      ) : null}
    </section>
  );
}
