"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Share2, Loader2, RefreshCw, BookOpen, Maximize2, X } from "lucide-react";

/**
 * 研究知识图谱面板（Understand-Anything 融合，设计文档 4.7）
 *
 * 展示平台历史深度研究沉淀的知识图谱：
 * - SVG 径向图：report 内圈 / topic 中圈 / entity 外圈，边连接关联节点
 * - 「放大」弹窗：同构径向图的大画布视图（更多节点、更大字号）
 * - 最近历史研究列表（点击回看对应研究）
 * - 一键重建（从存量报告重新抽取）
 * 零新增依赖（纯 SVG 静态布局）。
 */

interface GraphNode {
  id: string;
  label: string;
  type: "entity" | "topic" | "report";
  summary: string;
  reportIds: string[];
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

interface GraphReport {
  questionId: string;
  question: string;
  objective: string;
  summary: string;
  createdAt: string;
}

interface GraphData {
  updatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  reports: GraphReport[];
  stats: { nodeCount: number; edgeCount: number; reportCount: number };
}

/** 节点类型配色（复用主题 CSS 变量） */
const TYPE_COLOR: Record<GraphNode["type"], string> = {
  report: "var(--purple)",
  topic: "var(--warning)",
  entity: "var(--success)",
};

/** 径向视图配置：区分面板小视图与弹窗放大视图 */
interface GraphViewConfig {
  width: number;
  height: number;
  cx: number;
  cy: number;
  rings: Record<GraphNode["type"], { r: number; offset: number }>;
  /** 各类型节点展示上限（被更多研究引用的优先） */
  limit: Record<GraphNode["type"], number>;
  nodeScale: number;
  fontSize: number;
  labelLimit: number;
}

/** 面板小视图 */
const SMALL_VIEW: GraphViewConfig = {
  width: 420,
  height: 280,
  cx: 210,
  cy: 140,
  rings: {
    report: { r: 50, offset: -Math.PI / 2 },
    topic: { r: 100, offset: -Math.PI / 3 },
    entity: { r: 145, offset: -Math.PI / 2.5 },
  },
  limit: { report: 6, topic: 4, entity: 12 },
  nodeScale: 1,
  fontSize: 8.5,
  labelLimit: 10,
};

/** 弹窗放大视图：更大画布、更多节点、更大字号 */
const LARGE_VIEW: GraphViewConfig = {
  width: 960,
  height: 620,
  cx: 480,
  cy: 310,
  rings: {
    report: { r: 105, offset: -Math.PI / 2 },
    topic: { r: 205, offset: -Math.PI / 3 },
    entity: { r: 290, offset: -Math.PI / 2.5 },
  },
  limit: { report: 10, topic: 8, entity: 30 },
  nodeScale: 1.8,
  fontSize: 12,
  labelLimit: 14,
};

/** 径向布局：三类节点分置三个同心环，按索引均分角度 */
function layoutNodes(
  nodes: GraphNode[],
  config: GraphViewConfig,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  (Object.keys(config.rings) as GraphNode["type"][]).forEach((type) => {
    const ring = config.rings[type];
    const group = nodes.filter((n) => n.type === type);
    group.forEach((n, i) => {
      const angle = ring.offset + (i / group.length) * Math.PI * 2;
      pos.set(n.id, { x: config.cx + ring.r * Math.cos(angle), y: config.cy + ring.r * Math.sin(angle) });
    });
  });
  return pos;
}

/** 图例（小视图与放大视图共用） */
function GraphLegend() {
  return (
    <div className="mt-1 flex items-center justify-center gap-3 text-xs" style={{ color: "var(--muted)" }}>
      {(Object.keys(TYPE_COLOR) as GraphNode["type"][]).map((t) => (
        <span key={t} className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[t] }} />
          {t === "report" ? "研究" : t === "topic" ? "主题" : "实体"}
        </span>
      ))}
    </div>
  );
}

/** 径向图谱 SVG：面板小视图与弹窗放大视图复用（仅配置不同） */
function GraphSvg({
  data,
  config,
  onOpenReport,
}: {
  data: GraphData;
  config: GraphViewConfig;
  /** 点击 report 节点回看对应研究 */
  onOpenReport?: (questionId: string) => void;
}) {
  const displayNodes = useMemo(() => {
    const pick = (type: GraphNode["type"]) =>
      data.nodes
        .filter((n) => n.type === type)
        .sort((a, b) => b.reportIds.length - a.reportIds.length)
        .slice(0, config.limit[type]);
    return [...pick("report"), ...pick("topic"), ...pick("entity")];
  }, [data, config]);

  const positions = useMemo(() => layoutNodes(displayNodes, config), [displayNodes, config]);
  const displayIds = useMemo(() => new Set(displayNodes.map((n) => n.id)), [displayNodes]);

  return (
    <svg
      viewBox={`0 0 ${config.width} ${config.height}`}
      className="w-full"
      role="img"
      aria-label="研究知识图谱径向图"
    >
      {/* 关系边（端点均可见时才绘制） */}
      {data.edges.map((e, i) => {
        const from = positions.get(e.source);
        const to = positions.get(e.target);
        if (!from || !to || !displayIds.has(e.source) || !displayIds.has(e.target)) return null;
        return (
          <line
            key={i}
            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke="var(--line)" strokeWidth={config.nodeScale} opacity={0.9}
          >
            <title>{e.relation}</title>
          </line>
        );
      })}
      {/* 节点 */}
      {displayNodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return null;
        const baseR = n.type === "report" ? 7 : n.type === "topic" ? 6 : 5;
        const r = baseR * config.nodeScale;
        const clickable = n.type === "report" && Boolean(onOpenReport);
        return (
          <g
            key={n.id}
            style={{ cursor: clickable ? "pointer" : "default" }}
            onClick={() => clickable && onOpenReport?.(n.id)}
          >
            <circle cx={p.x} cy={p.y} r={r} fill={TYPE_COLOR[n.type]} opacity={0.85}>
              <title>{`${n.label}${n.summary ? `：${n.summary}` : ""}`}</title>
            </circle>
            <text
              x={p.x} y={p.y - r - 3}
              textAnchor="middle" fontSize={config.fontSize}
              fill="var(--ink-soft)"
            >
              {n.label.length > config.labelLimit ? `${n.label.slice(0, config.labelLimit)}…` : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function GraphPanel({
  refreshSignal = 0,
  onOpenQuestion,
}: {
  /** 外部递增触发刷新（如一次研究完成后） */
  refreshSignal?: number;
  /** 点击 report 节点/历史研究项时回看对应研究（按 questionId） */
  onOpenQuestion?: (questionId: string) => void;
}) {
  const [rebuilding, setRebuilding] = useState(false);
  /** 放大弹窗开关 */
  const [expanded, setExpanded] = useState(false);

  // 弹窗打开时监听 Esc 关闭（订阅外部事件，卸载时清理）
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // SWR 拉取图谱：外部研究完成后递增 refreshSignal 触发重新拉取（本次研究已沉淀入图）
  const { data: data = null, isValidating, mutate } = useSWR<GraphData | null>(
    ["/api/v1/research/graph", refreshSignal],
    async ([url]: [string, number]) => {
      try {
        const res = await fetch(url);
        const json = await res.json();
        return json.ok ? (json.data as GraphData) : null;
      } catch {
        // 图谱接口不可用时静默隐藏面板内容
        return null;
      }
    },
  );
  const loading = isValidating && !data;

  /** 一键重建：从存量已完成研究重新抽取图谱 */
  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await fetch("/api/v1/research/graph/rebuild", { method: "POST" });
      await mutate();
    } finally {
      setRebuilding(false);
    }
  }, [mutate]);

  /** 放大视图中点击 report 节点：关闭弹窗并回看对应研究 */
  const openReportFromLargeView = useCallback(
    (questionId: string) => {
      setExpanded(false);
      onOpenQuestion?.(questionId);
    },
    [onOpenQuestion],
  );

  if (loading) return null;
  const empty = !data || data.stats.reportCount === 0;

  return (
    <>
      <section
        className="rounded-[var(--radius-sm)] border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
            <Share2 size={14} style={{ color: "var(--purple)" }} />
            研究知识图谱
            {data && !empty && (
              <span className="font-normal text-xs" style={{ color: "var(--muted)" }}>
                {data.stats.nodeCount} 节点 · {data.stats.edgeCount} 关系 · {data.stats.reportCount} 研究
              </span>
            )}
          </h3>
          {!empty && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-xs transition-all hover:bg-black/[0.03] active:scale-95"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              >
                <Maximize2 size={11} />
                放大
              </button>
              <button
                onClick={rebuild}
                disabled={rebuilding}
                className="flex items-center gap-1 rounded-[8px] border px-2 py-1 text-xs transition-all hover:bg-black/[0.03] active:scale-95 disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              >
                {rebuilding ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                重建
              </button>
            </div>
          )}
        </div>

        {empty ? (
          <p className="py-4 text-center text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            完成第一次深度研究后，平台将自动从报告中抽取实体、主题与关系，
            <br />
            沉淀为可复用的研究知识图谱，让后续研究站在历史结论之上向外延展。
          </p>
        ) : (
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
            {/* 径向图谱（小视图） */}
            <div>
              <GraphSvg data={data!} config={SMALL_VIEW} onOpenReport={onOpenQuestion} />
              <GraphLegend />
            </div>

            {/* 最近历史研究（点击回看） */}
            <div className="min-w-0 space-y-2">
              <p className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>最近沉淀的研究</p>
              {data!.reports.slice(0, 3).map((r) => (
                <button
                  key={r.questionId}
                  onClick={() => onOpenQuestion?.(r.questionId)}
                  className="w-full rounded-[8px] border px-3 py-2 text-left transition-all hover:-translate-y-0.5"
                  style={{ borderColor: "var(--line)", background: "var(--paper)" }}
                >
                  <p className="flex items-center gap-1 text-xs font-medium" style={{ color: "var(--ink)" }}>
                    <BookOpen size={11} style={{ color: "var(--purple)" }} />
                    <span className="truncate">{r.question}</span>
                  </p>
                  {r.summary && (
                    <p className="mt-1 line-clamp-2 text-xs" style={{ color: "var(--muted)" }}>{r.summary}</p>
                  )}
                  <p className="mt-1 text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                    {r.createdAt.slice(0, 10)}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 放大弹窗：大画布径向图（点击遮罩/关闭按钮/Esc 关闭） */}
      {expanded && data && !empty && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgb(24 18 36 / 42%)" }}
          onClick={() => setExpanded(false)}
        >
          <div
            className="max-h-[calc(100%-48px)] w-[min(1040px,calc(100%-48px))] overflow-y-auto rounded-[var(--radius-sm)] border p-7"
            style={{ borderColor: "var(--line)", background: "#fff", boxShadow: "0 24px 80px rgb(28 18 48 / 24%)" }}
            role="dialog"
            aria-label="研究知识图谱放大视图"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold" style={{ color: "var(--ink)" }}>
                <Share2 size={16} style={{ color: "var(--purple)" }} />
                研究知识图谱
                <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>
                  {data.stats.nodeCount} 节点 · {data.stats.edgeCount} 关系 · {data.stats.reportCount} 研究 · 点击紫色研究节点可回看
                </span>
              </h2>
              <button
                onClick={() => setExpanded(false)}
                className="rounded-full p-1 transition-all hover:bg-black/5 active:scale-90"
                aria-label="关闭"
              >
                <X size={18} style={{ color: "var(--muted)" }} />
              </button>
            </div>
            <GraphSvg data={data} config={LARGE_VIEW} onOpenReport={openReportFromLargeView} />
            <GraphLegend />
          </div>
        </div>
      )}
    </>
  );
}
