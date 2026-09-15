"use client";

/**
 * 画布导入面板（右侧抽屉）
 * 从「数据分析」最近问答与「深度研究」任务中选择内容导入画布，建立实时绑定
 */
import { useCallback, useEffect, useState } from "react";
import { X, MessageSquareText, Telescope, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

/** 问答列表项（GET /api/v1/ask 返回结构） */
interface QuestionItem {
  id: string;
  content: string;
  status: string;
  createdAt: string;
  route: string | null;
  chartCount: number;
}

/** 研究任务列表项（GET /api/v1/research 返回结构） */
interface ResearchItem {
  id: string;
  question: string;
  status: string;
  completedAt: string | null;
  citationCount: number;
}

export interface ImportSource {
  sourceType: "question" | "research";
  sourceId: string;
  /**
   * 需导入的图表下标（问答弹窗多选传入）：
   * 有值时画布端按「一图一卡」创建多张实时卡片，缺省则整段内容为一张卡片。
   */
  chartIndexes?: number[];
}

/**
 * @param open 是否展开
 * @param onClose 关闭抽屉
 * @param onImport 选中来源后回调（父组件负责创建形状与绑定）
 */
export function ImportPanel({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (source: ImportSource) => Promise<void> | void;
}) {
  const [tab, setTab] = useState<"question" | "research">("question");
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [tasks, setTasks] = useState<ResearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState("");

  // 打开时拉取两类来源列表
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
      Promise.all([
        apiFetch("/api/v1/ask?page=1&pageSize=12"),
        apiFetch("/api/v1/research?page=1&pageSize=12"),
      ])
        .then(([askJson, researchJson]) => {
          if (cancelled) return;
          if (askJson.ok) setQuestions(askJson.data.questions ?? []);
          if (researchJson.ok) setTasks(researchJson.data.tasks ?? []);
        })
        .catch(() => {
          if (!cancelled) setError("加载导入来源失败");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleImport = useCallback(
    async (source: ImportSource) => {
      if (importing) return;
      setImporting(source.sourceId);
      setError("");
      try {
        await onImport(source);
      } catch {
        setError("导入失败，请重试");
      } finally {
        setImporting(null);
      }
    },
    [importing, onImport],
  );

  if (!open) return null;

  return (
    <div
      className="absolute right-3 top-3 bottom-3 z-40 flex w-[340px] flex-col overflow-hidden rounded-[var(--radius-sm)] border shadow-xl"
      style={{ borderColor: "var(--line)", background: "#fff" }}
      role="dialog"
      aria-label="导入数据面板"
    >
      {/* 头部 */}
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>导入内容</h3>
        <button onClick={onClose} className="rounded-full p-1 hover:bg-black/5" aria-label="关闭导入面板">
          <X size={16} style={{ color: "var(--muted)" }} />
        </button>
      </div>

      {/* Tab */}
      <div className="flex gap-2 px-4 pt-3">
        <button
          onClick={() => setTab("question")}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background: tab === "question" ? "var(--purple)" : "var(--paper)",
            color: tab === "question" ? "#fff" : "var(--ink-soft)",
          }}
        >
          <MessageSquareText size={12} />
          数据分析
        </button>
        <button
          onClick={() => setTab("research")}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background: tab === "research" ? "var(--purple)" : "var(--paper)",
            color: tab === "research" ? "#fff" : "var(--ink-soft)",
          }}
        >
          <Telescope size={12} />
          深度研究
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-2 rounded-[6px] px-2.5 py-1.5 text-xs" role="alert"
          style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin" style={{ color: "var(--muted)" }} />
          </div>
        ) : tab === "question" ? (
          questions.length === 0 ? (
            <EmptyTip text="暂无问答记录，先到「任务问答」发起分析" />
          ) : (
            questions.map((q) => (
              <button
                key={q.id}
                onClick={() => handleImport({ sourceType: "question", sourceId: q.id })}
                disabled={importing !== null}
                className="w-full rounded-[8px] border p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm disabled:opacity-50"
                style={{ borderColor: "var(--line)", background: "var(--paper)" }}
              >
                <p className="line-clamp-2 text-xs font-medium" style={{ color: "var(--ink)" }}>
                  {q.content}
                </p>
                <p className="mt-1 flex items-center gap-2 text-[10px]" style={{ color: "var(--muted)" }}>
                  <StatusDot status={q.status} />
                  {q.chartCount > 0 && <span>{q.chartCount} 张图表</span>}
                  {q.chartCount > 0 && <span>·</span>}
                  <span>{new Date(q.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>
                </p>
              </button>
            ))
          )
        ) : tasks.length === 0 ? (
          <EmptyTip text="暂无研究任务，先到「深度研究」发起任务" />
        ) : (
          tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => handleImport({ sourceType: "research", sourceId: t.id })}
              disabled={importing !== null}
              className="w-full rounded-[8px] border p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm disabled:opacity-50"
              style={{ borderColor: "var(--line)", background: "var(--paper)" }}
            >
              <p className="line-clamp-2 text-xs font-medium" style={{ color: "var(--ink)" }}>
                {importing === t.id ? <Loader2 size={11} className="mr-1 inline animate-spin" /> : null}
                {t.question}
              </p>
              <p className="mt-1 flex items-center gap-2 text-[10px]" style={{ color: "var(--muted)" }}>
                <StatusDot status={t.status} />
                {t.citationCount > 0 && <span>{t.citationCount} 引用</span>}
              </p>
            </button>
          ))
        )}
      </div>

      <div className="border-t px-4 py-2.5 text-[10px]" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
        导入后内容以实时卡片呈现，源任务更新时自动刷新
      </div>
    </div>
  );
}

function EmptyTip({ text }: { text: string }) {
  return (
    <p className="py-10 text-center text-xs" style={{ color: "var(--muted)" }}>
      {text}
    </p>
  );
}

/** 状态圆点：运行中紫色脉冲 / 完成绿 / 失败红 */
function StatusDot({ status }: { status: string }) {
  const color =
    status === "completed" ? "var(--success)"
    : status === "failed" ? "var(--danger)"
    : "var(--purple)";
  return <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />;
}
