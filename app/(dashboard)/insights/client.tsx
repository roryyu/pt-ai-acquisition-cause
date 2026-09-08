"use client";

/**
 * 洞察画布列表页：统一承载原 洞察报告 / 看板 / 日报 三模块
 * Tab 过滤文档类型，点击进入 tldraw 画布编辑器
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, PenTool, Trash2, X, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";

/** 文档类型元信息（图标/文案/主题色） */
const KIND_META = {
  report: { label: "报告", desc: "深度分析与经营洞察" },
  board: { label: "看板", desc: "关键指标实时监控" },
  digest: { label: "日报", desc: "定时摘要自动推送" },
} as const;

type DocKind = keyof typeof KIND_META;

interface InsightDoc {
  id: string;
  title: string;
  kind: DocKind;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  _count: { bindings: number };
}

/** Tab 选项：全部 + 三种类型 */
const TABS: Array<{ value: "" | DocKind; label: string }> = [
  { value: "", label: "全部" },
  { value: "report", label: "报告" },
  { value: "board", label: "看板" },
  { value: "digest", label: "日报" },
];

export function InsightsClient() {
  const router = useRouter();
  const [docs, setDocs] = useState<InsightDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"" | DocKind>("");
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState<DocKind>("report");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const loadDocs = useCallback(async (kind: "" | DocKind) => {
    setLoading(true);
    try {
      const qs = kind ? `?kind=${kind}` : "";
      const json = await apiFetch(`/api/v1/insights${qs}`);
      if (json.ok) setDocs(json.data.docs ?? []);
    } catch {
      setError("加载洞察文档列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => loadDocs(tab));
  }, [loadDocs, tab]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const json = await apiFetch("/api/v1/insights", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim(), kind: newKind }),
      });
      if (json.ok) {
        setShowCreate(false);
        setNewTitle("");
        // 创建后直接进入画布编辑
        router.push(`/insights/${json.data.id}`);
      } else {
        setError(json.error?.message ?? "创建失败");
      }
    } catch {
      setError("网络异常");
    } finally {
      setCreating(false);
    }
  }, [newTitle, newKind, creating, router]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("确定删除该洞察文档？画布内容与绑定将一并删除。")) return;
    try {
      await fetch(`/api/v1/insights/${id}`, { method: "DELETE" });
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch {
      setError("删除失败");
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[clamp(24px,3vw,36px)] font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
            洞察画布
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            报告 / 看板 / 日报统一画布：导入数据分析与深度研究，实时刷新、自由标注、导出与定时推送
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-[10px] px-4 py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5"
          style={{ background: "var(--purple)" }}
        >
          <Plus size={16} />
          新建画布
        </button>
      </div>

      {/* 类型 Tab */}
      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className="rounded-full px-4 py-1.5 text-xs font-medium transition-colors"
            style={{
              background: tab === t.value ? "var(--purple)" : "var(--surface)",
              color: tab === t.value ? "#fff" : "var(--ink-soft)",
              border: tab === t.value ? "none" : "1px solid var(--line)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-[8px] px-3 py-2 text-xs" role="alert"
          style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* 文档列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-20" role="status">
          <div className="text-sm" style={{ color: "var(--muted)" }}>加载中...</div>
        </div>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-[var(--radius-sm)] border py-20"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <PenTool size={48} style={{ color: "var(--line)" }} />
          <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
            暂无洞察文档，点击上方按钮创建第一个画布
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {docs.map((d) => (
            <div
              key={d.id}
              className="group relative overflow-hidden rounded-[var(--radius-sm)] border p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}
            >
              <Link href={`/insights/${d.id}`} className="block">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
                    style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
                  >
                    <PenTool size={18} />
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-medium" style={{ color: "var(--ink)" }}>
                        {d.title}
                      </h3>
                      <KindBadge kind={d.kind} />
                    </div>
                    {d.description && (
                      <p className="mt-0.5 line-clamp-1 text-xs" style={{ color: "var(--muted)" }}>
                        {d.description}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                      <Link2 size={11} />
                      <span>{d._count.bindings} 个实时绑定</span>
                      <span>·</span>
                      <span>{formatTime(d.updatedAt)}</span>
                    </div>
                  </div>
                </div>
              </Link>
              <button
                onClick={() => handleDelete(d.id)}
                className="absolute right-3 top-3 rounded-full p-1.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/5"
                aria-label="删除洞察文档"
              >
                <Trash2 size={14} style={{ color: "var(--muted)" }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 创建对话框 */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgb(24 18 36 / 42%)" }}>
          <div className="w-[min(480px,calc(100%-48px))] rounded-[var(--radius-sm)] border p-7"
            style={{ borderColor: "var(--line)", background: "#fff", boxShadow: "0 24px 80px rgb(28 18 48 / 24%)" }}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>新建洞察画布</h2>
              <button onClick={() => setShowCreate(false)} className="rounded-full p-1 hover:bg-black/5" aria-label="关闭">
                <X size={18} style={{ color: "var(--muted)" }} />
              </button>
            </div>
            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>文档类型</label>
                <div className="mt-1.5 flex gap-2">
                  {(Object.keys(KIND_META) as DocKind[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => setNewKind(k)}
                      className="flex-1 rounded-[8px] border px-3 py-2 text-xs transition-colors"
                      style={{
                        borderColor: newKind === k ? "var(--purple)" : "var(--line)",
                        background: newKind === k ? "var(--purple-pale)" : "var(--surface)",
                        color: newKind === k ? "var(--purple)" : "var(--ink-soft)",
                      }}
                    >
                      <span className="block font-medium">{KIND_META[k].label}</span>
                      <span className="mt-0.5 block text-[10px] opacity-70">{KIND_META[k].desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>画布标题</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="例：2026 Q3 经营监控画布"
                  className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none focus:border-[var(--purple)]"
                  style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)} className="rounded-[8px] px-4 py-2 text-sm hover:bg-black/5" style={{ color: "var(--ink-soft)" }}>
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim() || creating}
                className="rounded-[8px] px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--purple)" }}
              >
                {creating ? "创建中..." : "创建并进入画布"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 类型徽标 */
function KindBadge({ kind }: { kind: DocKind }) {
  return (
    <span
      className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium")}
      style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
    >
      {KIND_META[kind]?.label ?? kind}
    </span>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  return d.toLocaleDateString("zh-CN");
}
