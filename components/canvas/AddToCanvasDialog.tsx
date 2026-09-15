"use client";

/**
 * 「加入画布」弹窗：为问答/研究结果选择图表与目标洞察画布
 * 两步选择：先勾选要上画布的图表（默认全选），再选中目标画布（或内联新建），
 * 最后点「添加」确认才深链跳转 /insights/{docId}?import={sourceType}:{sourceId}&charts={下标}，
 * 由画布编辑器按「一图一卡」自动完成导入。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AreaChart,
  BarChart3,
  Check,
  LineChart,
  Loader2,
  PenTool,
  PieChart,
  Plus,
  Radar,
  Waypoints,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import type { ChartSpec } from "@/lib/agent-events";

/** 画布列表项（GET /api/v1/insights 返回结构） */
interface InsightDocItem {
  id: string;
  title: string;
  kind: string;
  updatedAt: string;
  _count?: { bindings?: number };
}

/** kind 中文徽标 */
const KIND_LABEL: Record<string, string> = {
  report: "报告",
  board: "看板",
  digest: "日报",
};

/** 图表类型图标与中文标签（勾选列表的类型提示） */
const CHART_TYPE_META: Record<string, { icon: typeof BarChart3; label: string }> = {
  bar: { icon: BarChart3, label: "柱状图" },
  line: { icon: LineChart, label: "折线图" },
  area: { icon: AreaChart, label: "面积图" },
  pie: { icon: PieChart, label: "饼图" },
  radar: { icon: Radar, label: "雷达图" },
  composed: { icon: Waypoints, label: "组合图" },
};

export function AddToCanvasDialog({
  open,
  onClose,
  sourceType,
  sourceId,
  sourceTitle,
  charts = [],
}: {
  open: boolean;
  onClose: () => void;
  sourceType: "question" | "research";
  sourceId: string;
  /** 来源标题（问题内容），用于新建画布时的默认标题 */
  sourceTitle: string;
  /** 来源图表清单：非空时弹窗展示图表多选，逐个下标导入为独立卡片 */
  charts?: ChartSpec[];
}) {
  const router = useRouter();
  const [docs, setDocs] = useState<InsightDocItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState("");
  /** 当前选中的目标画布：点击行仅选中，需再点「添加」确认后才跳转导入 */
  const [selectedId, setSelectedId] = useState("");
  /** 被取消勾选的图表下标（默认全选，只记录例外，避免图表清单变化时重置失效） */
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());

  /** 图表身份指纹：来源切换时重置勾选态，而不必把数组引用放进依赖 */
  const chartKey = useMemo(() => charts.map((c) => c.title).join("|"), [charts]);
  /** 已勾选的图表下标（升序） */
  const selectedCharts = useMemo(
    () => charts.map((_, i) => i).filter((i) => !unchecked.has(i)),
    [charts, unchecked],
  );

  // 打开时拉取画布列表，并预填新建标题
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => {
      if (cancelled) return;
      setNewTitle(sourceTitle ? `洞察：${sourceTitle.slice(0, 30)}` : "新洞察画布");
      setError("");
      setSelectedId("");
      setUnchecked(new Set());
      setLoading(true);
      apiFetch("/api/v1/insights?page=1&pageSize=20")
        .then((json) => {
          if (cancelled) return;
          if (json.ok) setDocs(json.data.docs ?? []);
          else setError("加载画布列表失败");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [open, sourceTitle, chartKey]);

  /** 勾选/取消单张图表 */
  const toggleChart = useCallback((index: number) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /** 全选 / 全不选 */
  const toggleAllCharts = useCallback(() => {
    setUnchecked((prev) => (prev.size === 0 ? new Set(charts.map((_, i) => i)) : new Set()));
  }, [charts]);

  /** 图表多选是否就绪：无图表来源（如研究）视为就绪 */
  const chartsReady = charts.length === 0 || selectedCharts.length > 0;

  /** 深链跳转到目标画布并携带导入参数（含勾选的图表下标） */
  const gotoWithImport = useCallback(
    (docId: string) => {
      const base = `/insights/${docId}?import=${sourceType}:${sourceId}`;
      // 一图一卡：下标随行传入，画布端为每个下标创建一张实时卡片
      const chartParam = charts.length > 0 ? `&charts=${selectedCharts.join(",")}` : "";
      router.push(`${base}${chartParam}`);
      onClose();
    },
    [router, sourceType, sourceId, charts.length, selectedCharts, onClose],
  );

  /** 内联新建画布后直接携带导入跳转 */
  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (creating) return;
    if (!title || !chartsReady) return;
    setCreating(true);
    setError("");
    try {
      const json = await apiFetch("/api/v1/insights", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, kind: "report" }),
      });
      if (!json.ok) {
        setError(json.error?.message ?? "创建画布失败");
        return;
      }
      gotoWithImport(json.data.id);
    } catch {
      setError("网络异常，创建失败");
    } finally {
      setCreating(false);
    }
  }, [newTitle, creating, chartsReady, gotoWithImport]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgb(24 18 36 / 42%)" }}>
      <div
        className="max-h-[calc(100vh-64px)] w-[min(520px,calc(100%-48px))] overflow-y-auto rounded-[var(--radius-sm)] border p-6"
        style={{ borderColor: "var(--line)", background: "#fff", boxShadow: "0 24px 80px rgb(28 18 48 / 24%)" }}
        role="dialog"
        aria-label="加入洞察画布"
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold" style={{ color: "var(--ink)" }}>
            <PenTool size={15} style={{ color: "var(--purple)" }} />
            加入洞察画布
          </h2>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-black/5" aria-label="关闭">
            <X size={17} style={{ color: "var(--muted)" }} />
          </button>
        </div>
        <p className="mt-1.5 line-clamp-1 text-xs" style={{ color: "var(--muted)" }}>
          {sourceTitle}
        </p>

        {error && (
          <div className="mt-3 rounded-[6px] px-2.5 py-1.5 text-xs" role="alert"
            style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
            {error}
          </div>
        )}

        {/* ① 选择图表：默认全选，一图一卡上画布 */}
        {charts.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                ① 选择图表（已选 {selectedCharts.length}/{charts.length}）
              </span>
              <button
                onClick={toggleAllCharts}
                className="text-[11px] underline decoration-dotted"
                style={{ color: "var(--purple)" }}
              >
                {unchecked.size === 0 ? "全不选" : "全选"}
              </button>
            </div>
            <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto">
              {charts.map((chart, i) => {
                const checked = !unchecked.has(i);
                const meta = CHART_TYPE_META[chart.type];
                const Icon = meta?.icon ?? BarChart3;
                return (
                  <button
                    key={`${chart.type}-${chart.title}-${i}`}
                    onClick={() => toggleChart(i)}
                    aria-pressed={checked}
                    className="flex w-full items-center gap-2 rounded-[8px] border px-2.5 py-2 text-left transition-colors"
                    style={{
                      borderColor: checked ? "var(--purple)" : "var(--line)",
                      background: checked ? "var(--purple-pale)" : "var(--paper)",
                    }}
                  >
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border"
                      style={{
                        borderColor: checked ? "var(--purple)" : "var(--line)",
                        background: checked ? "var(--purple)" : "#fff",
                      }}
                      aria-hidden
                    >
                      {checked && <Check size={11} color="#fff" />}
                    </span>
                    <Icon size={13} className="shrink-0" style={{ color: "var(--purple)" }} />
                    <span className="flex-1 truncate text-xs" style={{ color: "var(--ink)" }}>
                      {chart.title}
                    </span>
                    <span className="shrink-0 text-[10px]" style={{ color: "var(--muted)" }}>
                      {meta?.label ?? chart.type}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ② 已有画布列表：点击仅选中，需再点「添加」确认 */}
        <div className="mt-4">
          <span className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
            {charts.length > 0 ? "② 选择画布" : "选择画布"}
          </span>
        </div>
        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin" style={{ color: "var(--muted)" }} />
            </div>
          ) : docs.length === 0 ? (
            <p className="py-6 text-center text-xs" style={{ color: "var(--muted)" }}>
              暂无画布，请先新建
            </p>
          ) : (
            docs.map((d) => {
              const selected = selectedId === d.id;
              return (
                <button
                  key={d.id}
                  onClick={() => setSelectedId(selected ? "" : d.id)}
                  aria-pressed={selected}
                  className="flex w-full items-center gap-2.5 rounded-[8px] border px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm"
                  style={{
                    borderColor: selected ? "var(--purple)" : "var(--line)",
                    background: selected ? "var(--purple-pale)" : "var(--paper)",
                  }}
                >
                  <span className="flex-1 truncate text-sm" style={{ color: "var(--ink)" }}>{d.title}</span>
                  <span className="shrink-0 rounded-full px-2 py-px text-[10px] font-medium"
                    style={{ background: "var(--purple-pale)", color: "var(--purple)" }}>
                    {KIND_LABEL[d.kind] ?? d.kind}
                  </span>
                  {(d._count?.bindings ?? 0) > 0 && (
                    <span className="shrink-0 text-[10px]" style={{ color: "var(--muted)" }}>
                      {d._count!.bindings} 卡片
                    </span>
                  )}
                  {selected && <Check size={14} className="shrink-0" style={{ color: "var(--purple)" }} />}
                </button>
              );
            })
          )}
        </div>

        {/* 选中确认：避免误触行即跳离问答页 */}
        {docs.length > 0 && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
              {!selectedId
                ? "请选择目标画布"
                : !chartsReady
                  ? "请至少勾选一张图表"
                  : `将添加${charts.length > 0 ? ` ${selectedCharts.length} 张图表` : "问答内容"}到：${
                      docs.find((d) => d.id === selectedId)?.title ?? ""
                    }`}
            </span>
            <button
              onClick={() => selectedId && chartsReady && gotoWithImport(selectedId)}
              disabled={!selectedId || !chartsReady}
              className="flex shrink-0 items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: "var(--purple)" }}
            >
              <PenTool size={13} />
              添加
            </button>
          </div>
        )}

        {/* 内联新建 */}
        <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--line)" }}>
          <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
            或新建画布
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
              maxLength={200}
              className="flex-1 rounded-[8px] border px-3 py-2 text-sm outline-none focus:border-[var(--purple)]"
              style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
              placeholder="画布标题"
            />
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim() || creating || !chartsReady}
              className="flex shrink-0 items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: "var(--purple)" }}
            >
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              新建并添加
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
