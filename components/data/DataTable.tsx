"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { TablePayload } from "@/lib/agent-events";

/**
 * 数据表格：Agent 查询结果 / 数据预览 / 算子试运行结果共用
 * 支持数值右对齐、大结果折叠展开、行数上限提示
 */
export function DataTable({
  title,
  columns,
  rows,
  note,
  defaultOpen = true,
  maxHeight = 320,
}: {
  title?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  note?: string;
  defaultOpen?: boolean;
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);

  const displayRows = useMemo(() => {
    const limit = expanded ? rows.length : Math.min(rows.length, 12);
    // 行无天然 id：用「各列内容拼接」派生稳定 key，重复行追加序号去重，避免 index-as-key
    const seen = new Map<string, number>();
    return rows.slice(0, limit).map((row) => {
      const base = columns.map((c) => String(row[c] ?? "")).join("\u0000");
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { row, rowKey: n === 0 ? base : `${base}\u0001${n}` };
    });
  }, [rows, expanded, columns]);

  if (rows.length === 0) {
    return (
      <div className="rounded-[var(--radius-sm)] border px-4 py-3 text-xs" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
        {title ? `${title}：` : ""}暂无数据
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-sm)] border" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      {title && (
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left"
        >
          <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {title}
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--muted)" }}>
              {rows.length} 行{note ? ` · ${note}` : ""}
            </span>
          </span>
          {open ? <ChevronUp size={14} style={{ color: "var(--muted)" }} /> : <ChevronDown size={14} style={{ color: "var(--muted)" }} />}
        </button>
      )}
      {open && (
        <div className="overflow-auto" style={{ maxHeight }}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "var(--purple-pale)" }}>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-2 text-left font-semibold"
                    style={{ color: "var(--ink)" }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ row, rowKey }) => (
                <tr
                  key={rowKey}
                  className="border-t"
                  style={{ borderColor: "var(--line)" }}
                >
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="whitespace-nowrap px-3 py-1.5"
                      style={{
                        color: "var(--ink-soft)",
                        textAlign: isNumeric(row[col]) ? "right" : "left",
                        fontVariantNumeric: isNumeric(row[col]) ? "tabular-nums" : undefined,
                      }}
                    >
                      {formatCell(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 12 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full border-t py-1.5 text-xs transition-colors hover:bg-black/[0.02]"
              style={{ borderColor: "var(--line)", color: "var(--purple)" }}
            >
              {expanded ? "收起" : `展开全部 ${rows.length} 行`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function isNumeric(v: unknown): boolean {
  return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)));
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toLocaleString("zh-CN") : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 兼容 TablePayload 直传 */
export function TablePayloadView({ payload }: { payload: TablePayload }) {
  return (
    <DataTable
      title={payload.title}
      columns={payload.columns}
      rows={payload.rows}
      note={payload.note}
    />
  );
}
