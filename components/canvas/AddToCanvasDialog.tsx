"use client";

/**
 * 「加入画布」弹窗：为问答/研究结果选择目标洞察画布
 * 支持选择已有画布或内联新建；选定后深链跳转
 * /insights/{docId}?import={sourceType}:{sourceId}，由画布编辑器自动完成导入。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PenTool, Plus, X } from "lucide-react";

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

export function AddToCanvasDialog({
  open,
  onClose,
  sourceType,
  sourceId,
  sourceTitle,
}: {
  open: boolean;
  onClose: () => void;
  sourceType: "question" | "research";
  sourceId: string;
  /** 来源标题（问题内容），用于新建画布时的默认标题 */
  sourceTitle: string;
}) {
  const router = useRouter();
  const [docs, setDocs] = useState<InsightDocItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState("");

  // 打开时拉取画布列表，并预填新建标题
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => {
      if (cancelled) return;
      setNewTitle(sourceTitle ? `洞察：${sourceTitle.slice(0, 30)}` : "新洞察画布");
      setError("");
      setLoading(true);
      fetch("/api/v1/insights?page=1&pageSize=20")
        .then((r) => r.json())
        .then((json) => {
          if (!cancelled && json.ok) setDocs(json.data.docs ?? []);
        })
        .catch(() => {
          if (!cancelled) setError("加载画布列表失败");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [open, sourceTitle]);

  /** 深链跳转到目标画布并携带导入参数 */
  const gotoWithImport = useCallback(
    (docId: string) => {
      router.push(`/insights/${docId}?import=${sourceType}:${sourceId}`);
      onClose();
    },
    [router, sourceType, sourceId, onClose],
  );

  /** 内联新建画布后直接携带导入跳转 */
  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/v1/insights", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, kind: "report" }),
      });
      const json = await res.json();
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
  }, [newTitle, creating, gotoWithImport]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgb(24 18 36 / 42%)" }}>
      <div
        className="w-[min(480px,calc(100%-48px))] rounded-[var(--radius-sm)] border p-6"
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

        {/* 已有画布列表 */}
        <div className="mt-4 max-h-56 space-y-2 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin" style={{ color: "var(--muted)" }} />
            </div>
          ) : docs.length === 0 ? (
            <p className="py-6 text-center text-xs" style={{ color: "var(--muted)" }}>
              暂无画布，请先新建
            </p>
          ) : (
            docs.map((d) => (
              <button
                key={d.id}
                onClick={() => gotoWithImport(d.id)}
                className="flex w-full items-center gap-2.5 rounded-[8px] border px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm"
                style={{ borderColor: "var(--line)", background: "var(--paper)" }}
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
              </button>
            ))
          )}
        </div>

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
              disabled={!newTitle.trim() || creating}
              className="flex shrink-0 items-center gap-1.5 rounded-[8px] px-3.5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: "var(--purple)" }}
            >
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              新建并加入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
