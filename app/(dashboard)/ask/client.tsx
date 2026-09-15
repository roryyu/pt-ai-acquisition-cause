"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send, Loader2, Clock, MessageSquareText, Square, Database, Globe, MessageCircle,
  Sparkles, ChevronDown, ChevronUp, RefreshCw, Trash2,
  BarChart3, TrendingDown, TrendingUp, Layers, PenTool, Telescope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";
import { useAgentStream } from "@/hooks/use-agent-stream";
import type { AgentStreamState, ChartSpec, Citation, TablePayload } from "@/lib/agent-events";
import { AgentTimeline, CitationList } from "@/components/agent/AgentTimeline";
import { DataTable } from "@/components/data/DataTable";
import { AddToCanvasDialog } from "@/components/canvas/AddToCanvasDialog";

/**
 * 重组件动态导入：recharts / react-markdown 仅在产出结果后才需要，
 * 拆出首屏 chunk，降低路由切换时的 JS 下载与求值开销
 */
const MarkdownView = dynamic(() =>
  import("@/components/agent/MarkdownView").then((m) => m.MarkdownView),
);
const ChartRenderer = dynamic(
  () => import("@/components/charts/ChartRenderer").then((m) => m.ChartRenderer),
  { ssr: false },
);

/**
 * 任务问答（design.md 7.1 核心交互）
 *
 * 多 Agent 工作流全程可视化：
 * 问题 → Supervisor 意图路由 →（DataAnalyst NL2SQL / Researcher 检索 / 直接回答）→ Synthesizer
 * 实时展示：Agent 推理时间线 / SQL 与工具调用 / 图表 / 表格 / 流式回答 / 引用来源
 */

interface HistoryItem {
  id: string;
  content: string;
  status: string;
  createdAt: string;
  route?: string | null;
  chartCount?: number;
  critiqueScore?: number | null;
  elapsedMs?: number | null;
  answerPreview?: string;
  /** 追问轮次（带父问答），侧边栏用于区分新话题与追问 */
  isFollowUp?: boolean;
}

/** 会话线程中的历史轮次（轻量，不含图表/表格） */
interface ThreadTurn {
  id?: string;
  question: string;
  answerContent: string;
  route?: string | null;
}

/** 历史问答的持久化答案结构 */
interface PersistedAnswer {
  content?: string;
  route?: string;
  charts?: ChartSpec[];
  tables?: TablePayload[];
  sql?: string[];
  citations?: Citation[];
  critique?: { passed: boolean; score: number; issues: string[] } | null;
  elapsedMs?: number;
  error?: string;
}

export function AskClient({ initialQuestionId }: { initialQuestionId?: string }) {
  const router = useRouter();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<string>("");
  /** 会话线程：当前追问之前已完成的轮次（上下文内继续，而非新建对话） */
  const [thread, setThread] = useState<ThreadTurn[]>([]);
  /** "加入画布"弹窗开关（深链跳转选画布） */
  const [addToCanvasOpen, setAddToCanvasOpen] = useState(false);
  /** 历史回看模式：从持久化答案渲染（非流式） */
  const [viewing, setViewing] = useState<{
    question: string;
    answer: PersistedAnswer;
    status: string;
  } | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(true);

  const { state, streaming, start, stop, reset } = useAgentStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const json = await apiFetch("/api/v1/ask");
      if (json.ok) setHistory(json.data.questions ?? []);
    } catch {
      // 静默失败
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(loadHistory);
  }, [loadHistory]);

  /** 流式输出时自动滚底 */
  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state, streaming]);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    setInput("");
    setError("");
    setViewing(null);
    setCurrentQuestion(trimmed);
    setCurrentQuestionId(null);
    setTimelineOpen(true);

    // 追问：把当前已完成的轮次追加进会话线程，新回答在其下方流式续接；
    // 上一轮优先取历史回看内容，否则取刚结束的实时流产出
    const prevTurn: ThreadTurn | null = viewing
      ? {
          id: currentQuestionId ?? undefined,
          question: viewing.question,
          answerContent: viewing.answer.content ?? "",
          route: viewing.answer.route ?? null,
        }
      : state.done && !state.error && currentQuestion
        ? {
            id: currentQuestionId ?? state.questionId ?? undefined,
            question: currentQuestion,
            answerContent: state.answer,
          }
        : null;
    if (prevTurn) setThread((prev) => [...prev, prevTurn]);

    // 乐观插入历史记录（服务端在建题时即落库），提问后立即可见
    const optimisticId = `pending-${Date.now()}`;
    setHistory((prev) => [
      { id: optimisticId, content: trimmed, status: "analyzing", createdAt: new Date().toISOString() },
      ...prev,
    ]);

    try {
      await start(
        "/api/v1/ask",
        {
          question: trimmed,
          ...(currentQuestionId ? { parentQuestionId: currentQuestionId } : {}),
        },
        (final) => {
          if (final.error) setError(final.error);
          if (final.questionId) setCurrentQuestionId(final.questionId);
          loadHistory();
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常");
      loadHistory();
    } finally {
      inputRef.current?.focus();
    }
  }, [input, streaming, start, currentQuestionId, currentQuestion, loadHistory, viewing, state]);

  // 收到 meta 事件拿到真实 questionId 后，刷新列表以替换占位记录
  useEffect(() => {
    if (streaming && state.questionId) {
      // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
      Promise.resolve().then(loadHistory);
    }
  }, [streaming, state.questionId, loadHistory]);

  /** 删除历史问答 */
  const removeQuestion = useCallback(async (id: string) => {
    if (id.startsWith("pending-")) {
      // 尚未落库的占位记录，直接移除
      setHistory((prev) => prev.filter((q) => q.id !== id));
      return;
    }
    try {
      const json = await apiFetch(`/api/v1/ask/${id}`, { method: "DELETE" });
      if (!json.ok) return;
      if (currentQuestionId === id) {
        setViewing(null);
        setCurrentQuestionId(null);
        setCurrentQuestion("");
        setThread([]);
      }
      loadHistory();
    } catch {
      setError("删除失败，请重试");
    }
  }, [currentQuestionId, loadHistory]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  /** 查看历史问答详情（从持久化答案渲染） */
  const viewQuestion = useCallback(async (id: string) => {
    try {
      stop();
      const json = await apiFetch(`/api/v1/ask/${id}`);
      if (!json.ok) return;
      const q = json.data;
      setCurrentQuestionId(q.id);
      setCurrentQuestion(q.content);
      // 会话线程：从服务端返回的祖先问答链渲染（早到晚）
      setThread(
        ((q.thread ?? []) as Array<{ id: string; content: string; route: string | null; answerContent: string }>).map((t) => ({
          id: t.id,
          question: t.content,
          answerContent: t.answerContent,
          route: t.route,
        })),
      );
      setViewing({
        question: q.content,
        answer: (q.answer ?? {}) as PersistedAnswer,
        status: q.status,
      });
    } catch {
      setError("加载问答详情失败");
    }
  }, [stop]);

  // ?q={questionId} 深链：画布卡片"打开来源"回跳时自动加载对应问答
  useEffect(() => {
    if (!initialQuestionId) return;
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => viewQuestion(initialQuestionId));
  }, [initialQuestionId, viewQuestion]);

  const showingLive = streaming || (!viewing && state.steps.length > 0);

  /**
   * 流入目标问答 ID（加入画布 / 进行深入研究共用）：
   * 历史回看取左侧选中项，实时流取已落库的 questionId
   */
  const bridgeQuestionId = currentQuestionId ?? state.questionId;

  return (
    <div className="flex h-[calc(100vh-140px)] gap-5">
      {/* ── 左侧：历史 ── */}
      <aside
        className="flex w-72 shrink-0 flex-col overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
          <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>问答历史</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingHistory ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin" style={{ color: "var(--muted)" }} />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <MessageSquareText size={32} style={{ color: "var(--line)" }} />
              <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>暂无问答记录</p>
            </div>
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
              {history.map((q) => (
                <li key={q.id} className="group relative">
                  <button
                    onClick={() => viewQuestion(q.id)}
                    className={cn(
                      "w-full px-4 py-3 text-left transition-colors hover:bg-black/[0.02]",
                      currentQuestionId === q.id && "bg-[var(--purple-pale)]",
                    )}
                  >
                    <p className="line-clamp-2 pr-5 text-sm" style={{ color: "var(--ink)" }}>
                      {q.isFollowUp && (
                        <span className="mr-1" style={{ color: "var(--purple)" }}>↳</span>
                      )}
                      {q.content}
                    </p>
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs" style={{ color: "var(--muted)" }}>
                      <RouteBadge route={q.route} />
                      {q.status === "analyzing" ? (
                        <span className="flex items-center gap-1">
                          <Loader2 size={10} className="animate-spin" /> 分析中
                        </span>
                      ) : (
                        <>
                          <Clock size={10} />
                          <span>{formatTime(q.createdAt)}</span>
                        </>
                      )}
                      {q.status === "failed" && (
                        <span style={{ color: "var(--danger)" }}>失败</span>
                      )}
                    </div>
                  </button>
                  <button
                    onClick={() => removeQuestion(q.id)}
                    className="absolute right-2.5 top-2.5 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                    style={{ color: "var(--danger)" }}
                    aria-label="删除问答"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* ── 右侧：主交互区 ── */}
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
          {/* 空态引导 */}
          {!showingLive && !viewing && state.steps.length === 0 && thread.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center">
              <div
                className="flex h-16 w-16 items-center justify-center rounded-2xl"
                style={{ background: "var(--purple-pale)" }}
              >
                <Sparkles size={30} style={{ color: "var(--purple)" }} />
              </div>
              <h2 className="mt-4 text-lg font-bold" style={{ color: "var(--ink)" }}>任务问答</h2>
              <p className="mt-2 max-w-md text-center text-sm" style={{ color: "var(--muted)" }}>
                自然语言提问，AI 智能体将自主完成意图路由、数据查询（NL2SQL）、
                联网深度研究与可视化图表生成
              </p>
              <div className="mt-6 flex w-full max-w-lg flex-col gap-2">
                {[
                  { text: "对比Meta/X/TikTok今年以来的花费、下载、FD、RD与ROI，哪个渠道性价比最高？", icon: BarChart3 },
                  { text: "按投放渠道，安装量到注册量的转化率如何？月度变化是改善还是恶化了？", icon: TrendingDown },
                  { text: "TikTok的CPI为什么从6月开始明显上涨？", icon: TrendingUp },
                  { text: "app和web两个承接端的FD/RD转化有什么差异？召回充值应该侧重哪端？", icon: Layers },
                  { text: "2026年TikTok广告竞价成本上涨的原因及应对策略？", icon: Globe },
                ].map((s) => (
                  <button
                    key={s.text}
                    onClick={() => setInput(s.text)}
                    className="flex items-center gap-3 rounded-[10px] border px-4 py-2.5 text-left text-sm transition-all hover:-translate-y-0.5"
                    style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                  >
                    <s.icon size={15} style={{ color: "var(--purple)" }} />
                    {s.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 会话线程：追问前的历史轮次（上下文内继续） */}
          {thread.length > 0 && (
            <div className="mx-auto max-w-3xl space-y-4 pb-2">
              {thread.map((t) => (
                <ThreadTurnView key={t.id ?? `turn-${t.question}`} turn={t} />
              ))}
            </div>
          )}

          {/* 实时流式回答 */}
          {showingLive && (
            <div className="mx-auto max-w-3xl space-y-4">
              <QuestionBubble question={currentQuestion} />
              <CollapsibleTimeline state={state} open={timelineOpen} onToggle={() => setTimelineOpen(!timelineOpen)} />
              {state.charts.length > 0 && (
                <div className="grid gap-4 lg:grid-cols-2">
                  {state.charts.map((chart) => (
                    <ChartRenderer key={`${chart.type}-${chart.title}`} spec={chart} />
                  ))}
                </div>
              )}
              <TablesSection tables={state.tables} />
              {(state.answer || streaming) && (
                <div className="rounded-[var(--radius-sm)] border p-5" style={{ borderColor: "var(--line)" }}>
                  <MarkdownView content={state.answer} />
                  {streaming && !state.error && (
                    state.answer ? (
                      /* 已有流式文本：行尾闪烁光标 */
                      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse align-middle" style={{ background: "var(--purple)" }} />
                    ) : (
                      /* 等待首字：跳动小球加载动画 */
                      <div className="flex items-center gap-2.5 py-0.5">
                        <span className="thinking-ball" aria-hidden />
                        <span className="text-xs" style={{ color: "var(--muted)" }}>正在思考…</span>
                      </div>
                    )
                  )}
                </div>
              )}
              <CitationList citations={state.citations} />
              {state.done && state.elapsedMs !== null && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <p className="mr-1 text-xs" style={{ color: "var(--muted)" }}>
                    完成 · 耗时 {(state.elapsedMs / 1000).toFixed(1)}s
                  </p>
                  {/* 问答→画布 / 问答→深度研究流入入口：完成且已落库后可流入 */}
                  {bridgeQuestionId && !state.error && (
                    <>
                      <BridgePill
                        icon={PenTool}
                        label="加入画布"
                        title="把本次问答编入洞察画布"
                        onClick={() => setAddToCanvasOpen(true)}
                      />
                      <BridgePill
                        icon={Telescope}
                        label="进行深入研究"
                        title="以本次问答结论作为研究背景，前往深度研究补充研究方向"
                        primary
                        onClick={() => router.push(`/research?fromQuestion=${bridgeQuestionId}`)}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 历史回看 */}
          {viewing && !showingLive && (
            <div className="mx-auto max-w-3xl space-y-4">
              <QuestionBubble question={viewing.question} />
              {/* 详情头部：左侧路由/耗时元信息，右侧成组的流入操作 */}
              <div className="flex flex-wrap items-center justify-between gap-y-2">
                <RouteBanner answer={viewing.answer} status={viewing.status} />
                {/* 历史回看的流入入口：仅已落库完成的问答可入画布 / 转深度研究 */}
                {viewing.status === "completed" && bridgeQuestionId && (
                  <div className="flex shrink-0 items-center gap-2">
                    <BridgePill
                      icon={PenTool}
                      label="加入画布"
                      title="把本次问答编入洞察画布"
                      onClick={() => setAddToCanvasOpen(true)}
                    />
                    <BridgePill
                      icon={Telescope}
                      label="进行深入研究"
                      title="以本次问答结论作为研究背景，前往深度研究补充研究方向"
                      primary
                      onClick={() => router.push(`/research?fromQuestion=${bridgeQuestionId}`)}
                    />
                  </div>
                )}
              </div>
              {viewing.answer.charts && viewing.answer.charts.length > 0 && (
                <div className="grid gap-4 lg:grid-cols-2">
                  {viewing.answer.charts.map((chart) => (
                    <ChartRenderer key={`${chart.type}-${chart.title}`} spec={chart} />
                  ))}
                </div>
              )}
              <TablesSection tables={viewing.answer.tables ?? []} />
              {viewing.answer.content ? (
                <div className="rounded-[var(--radius-sm)] border p-5" style={{ borderColor: "var(--line)" }}>
                  <MarkdownView content={viewing.answer.content} />
                </div>
              ) : viewing.answer.error ? (
                <div className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                  执行失败：{viewing.answer.error}
                </div>
              ) : (
                <p className="text-center text-sm" style={{ color: "var(--muted)" }}>（该问题尚无回答）</p>
              )}
              <CitationList citations={viewing.answer.citations ?? []} />
              {viewing.answer.critique && (
                <p className="text-center text-xs" style={{ color: "var(--muted)" }}>
                  Critic 评分 {viewing.answer.critique.score}/10
                  {viewing.answer.critique.passed ? "（通过）" : "（未通过）"}
                </p>
              )}
            </div>
          )}
        </div>

        {error && (
          <div
            className="mx-6 mb-2 rounded-[8px] px-3 py-2 text-xs"
            role="alert"
            style={{ background: "var(--danger-pale)", color: "var(--danger)" }}
          >
            {error}
          </div>
        )}

        {/* 输入区 */}
        <div className="border-t px-4 py-3" style={{ borderColor: "var(--line)" }}>
          <div
            className="flex items-end gap-2 rounded-[10px] border px-3 py-2 transition-colors focus-within:border-[var(--purple)]"
            style={{ borderColor: "var(--line)", background: "var(--paper)" }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={currentQuestionId ? "继续追问...（Ctrl+Enter 发送）" : "输入您的业务问题...（Ctrl+Enter 发送）"}
              rows={2}
              className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
              style={{ color: "var(--ink)" }}
              disabled={streaming}
            />
            {streaming ? (
              <button
                onClick={stop}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] px-3 text-xs transition-all"
                style={{ background: "var(--danger-pale)", color: "var(--danger)" }}
                aria-label="停止生成"
              >
                <Square size={14} /> 停止
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!input.trim()}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] transition-all",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
                style={{
                  background: input.trim() ? "var(--purple)" : "var(--line)",
                  color: "#fff",
                }}
                aria-label="发送问题"
              >
                <Send size={16} />
              </button>
            )}
          </div>
          <p className="mt-1.5 flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
            {currentQuestionId && !streaming && (
              <button
                onClick={() => { setViewing(null); setCurrentQuestionId(null); setCurrentQuestion(""); setThread([]); reset(); }}
                className="inline-flex items-center gap-1 underline decoration-dotted"
                style={{ color: "var(--purple)" }}
              >
                <RefreshCw size={10} /> 新话题
              </button>
            )}
            AI 生成内容仅供参考 · 支持多轮追问
          </p>
        </div>
      </div>

      {/* 加入画布弹窗：勾图表 + 选画布/新建，确认后深链跳转自动一图一卡导入 */}
      <AddToCanvasDialog
        open={addToCanvasOpen}
        onClose={() => setAddToCanvasOpen(false)}
        sourceType="question"
        sourceId={bridgeQuestionId ?? ""}
        sourceTitle={viewing ? viewing.question : currentQuestion}
        charts={(viewing?.answer.charts ?? state.charts) ?? []}
      />
    </div>
  );
}

/** 用户问题气泡 */
function QuestionBubble({ question }: { question: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] rounded-[14px] rounded-tr-sm px-4 py-2.5 text-sm"
        style={{ background: "var(--purple)", color: "#fff" }}
      >
        {question}
      </div>
    </div>
  );
}

/**
 * 下游流入胶囊按钮（加入画布 / 进行深入研究）
 * 实时完成区与历史详情头部共用，保证两处入口的行为与观感一致；
 * primary 变体用于主行动（转深度研究），以紫色描边+浅底突出
 */
function BridgePill({
  icon: Icon,
  label,
  title,
  primary = false,
  onClick,
}: {
  icon: typeof PenTool;
  label: string;
  title: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-all hover:-translate-y-0.5"
      style={{
        borderColor: primary ? "var(--purple)" : "var(--line)",
        background: primary ? "var(--purple-pale)" : "transparent",
        color: "var(--purple)",
      }}
    >
      <Icon size={11} /> {label}
    </button>
  );
}

/** 会话线程中的历史轮次：问题气泡 + 可展开的回答（默认收起保持线程轻量） */
function ThreadTurnView({ turn }: { turn: ThreadTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 opacity-90">
      <QuestionBubble question={turn.question} />
      <div className="rounded-[var(--radius-sm)] border" style={{ borderColor: "var(--line)" }}>
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <RouteBadge route={turn.route} />
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 text-xs transition-colors"
            style={{ color: "var(--purple)" }}
          >
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {open ? "收起回答" : "展开回答"}
          </button>
        </div>
        {open ? (
          <div className="border-t px-4 py-3" style={{ borderColor: "var(--line)" }}>
            {turn.answerContent ? (
              <MarkdownView content={turn.answerContent} />
            ) : (
              <p className="text-xs" style={{ color: "var(--muted)" }}>（该轮无回答）</p>
            )}
          </div>
        ) : (
          <p className="line-clamp-2 px-4 pb-2.5 text-xs" style={{ color: "var(--muted)" }}>
            {turn.answerContent.slice(0, 160) || "（该轮无回答）"}
          </p>
        )}
      </div>
    </div>
  );
}

/** 判断是否为算子中间结果表（标题约定来自 lib/server/agents/tools.ts run_operator） */
function isOperatorTable(t: TablePayload): boolean {
  return t.title.startsWith("算子结果 ·");
}

/** 表格区：查询/展示等结果表照常渲染；算子中间结果归组折叠，避免中间表铺满报告 */
function TablesSection({ tables }: { tables: TablePayload[] }) {
  if (tables.length === 0) return null;
  const operatorTables = tables.filter(isOperatorTable);
  const firstOperatorIdx = tables.findIndex(isOperatorTable);
  return (
    <>
      {tables.map((table, i) => {
        if (!isOperatorTable(table)) {
          return <DataTable key={`${i}-${table.title}`} title={table.title} columns={table.columns} rows={table.rows} note={table.note} defaultOpen={false} />;
        }
        // 仅在首个算子表位置渲染折叠分组，保持原有产出顺序
        if (i !== firstOperatorIdx) return null;
        return <OperatorResultsGroup key="operator-results" tables={operatorTables} />;
      })}
    </>
  );
}

/** 算子中间结果分组：默认折叠，点击展开查看各算子明细 */
function OperatorResultsGroup({ tables }: { tables: TablePayload[] }) {
  const [open, setOpen] = useState(false);
  if (tables.length === 0) return null;
  return (
    <div className="rounded-[var(--radius-sm)] border" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2 text-left transition-colors hover:bg-black/[0.02]"
      >
        <span className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--muted)" }}>
          <Layers size={13} style={{ color: "var(--purple)" }} />
          算子中间结果（{tables.length} 项）
        </span>
        {open ? <ChevronUp size={13} style={{ color: "var(--muted)" }} /> : <ChevronDown size={13} style={{ color: "var(--muted)" }} />}
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-3" style={{ borderColor: "var(--line)" }}>
          {tables.map((table, i) => (
            <DataTable key={`${i}-${table.title}`} title={table.title} columns={table.columns} rows={table.rows} note={table.note} defaultOpen={false} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 可折叠 Agent 时间线 */
function CollapsibleTimeline({
  state,
  open,
  onToggle,
}: {
  state: AgentStreamState;
  open: boolean;
  onToggle: () => void;
}) {
  if (state.steps.length === 0 && state.phases.length === 0) return null;
  if (open) {
    return (
      <div className="relative">
        <button
          onClick={onToggle}
          className="absolute right-3 top-2.5 z-10 flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
          style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--muted)" }}
        >
          <ChevronUp size={12} /> 收起过程
        </button>
        <AgentTimeline state={state} />
      </div>
    );
  }
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border py-2 text-xs transition-colors hover:bg-black/[0.02]"
      style={{ borderColor: "var(--line)", color: "var(--purple)" }}
    >
      <ChevronDown size={13} />
      展开 Agent 推理过程（{state.steps.length} 步）
    </button>
  );
}

/** 路由徽章 */
function RouteBadge({ route }: { route?: string | null }) {
  if (!route) return null;
  const meta: Record<string, { label: string; color: string; bg: string; icon: typeof Database }> = {
    data_analysis: { label: "数据分析", color: "#176e53", bg: "#e9f6ef", icon: Database },
    research: { label: "深度研究", color: "#875600", bg: "#fff4d5", icon: Globe },
    direct: { label: "直接回答", color: "#523b8f", bg: "#f0edf7", icon: MessageCircle },
  };
  const m = meta[route];
  if (!m) return null;
  const Icon = m.icon;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-xs font-medium"
      style={{ color: m.color, background: m.bg }}
    >
      <Icon size={9} />
      {m.label}
    </span>
  );
}

/** 历史回看：路由横幅 */
function RouteBanner({ answer, status }: { answer: PersistedAnswer; status: string }) {
  if (status === "failed") {
    return (
      <div className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
        该次执行失败
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <RouteBadge route={answer.route} />
      {answer.elapsedMs !== undefined && answer.elapsedMs !== null && (
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          耗时 {(answer.elapsedMs / 1000).toFixed(1)}s
          {answer.sql && answer.sql.length > 0 ? ` · ${answer.sql.length} 条 SQL` : ""}
        </span>
      )}
    </div>
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
