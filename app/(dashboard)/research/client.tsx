"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  Telescope, Loader2, Sparkles, Plus, Trash2, BookOpen,
  CheckCircle2, XCircle, Clock, FileText, ExternalLink, X, MessageSquareText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";
import { useAgentStream } from "@/hooks/use-agent-stream";
import { AgentTimeline, CitationList } from "@/components/agent/AgentTimeline";
import { GraphPanel } from "@/components/research/GraphPanel";

/** react-markdown 仅在产出报告后需要，拆出首屏 chunk 降低路由切换开销 */
const MarkdownView = dynamic(() =>
  import("@/components/agent/MarkdownView").then((m) => m.MarkdownView),
);

/**
 * 深度研究（design.md 4.3.2）
 * Planner→Executor→Synthesizer 多 Agent 工作流的可视化入口：
 * 发起研究任务（SSE 实时追踪研究计划/检索/撰写）+ 历史任务回看（子问题发现/引用/报告）
 */

interface TaskListItem {
  id: string;
  questionId: string | null;
  question: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  citationCount: number;
  elapsedMs: number | null;
  reportPreview: string;
}

interface ResearchAnswer {
  kind?: string;
  content?: string;
  objective?: string;
  subQuestions?: Array<{
    id: string;
    question: string;
    findings: string[];
    citationNos: number[];
    searchedQueries: string[];
    elapsedMs: number;
  }>;
  citations?: Array<{ no: number; title: string; url: string }>;
  elapsedMs?: number;
  error?: string;
}

interface TaskDetail {
  task: {
    id: string;
    questionId: string | null;
    question: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    answer: ResearchAnswer | null;
  };
  subTasks: Array<{
    id: string;
    status: string;
    input: { subQuestion?: string; rationale?: string; searchedQueries?: string[] } | null;
    output: { findings?: string[]; citationNos?: number[]; elapsedMs?: number } | null;
  }>;
}

/** 来源任务问答背景（任务问答「进行深入研究」深链载入） */
interface SourceQuestion {
  id: string;
  content: string;
  answerPreview: string;
}

/** 任务状态徽章 */
const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  queued: { label: "排队中", color: "var(--muted)", bg: "var(--line)" },
  planning: { label: "规划中", color: "var(--purple)", bg: "var(--purple-pale)" },
  collecting: { label: "检索中", color: "var(--warning)", bg: "var(--warning-pale)" },
  analyzing: { label: "分析中", color: "var(--purple)", bg: "var(--purple-pale)" },
  writing: { label: "撰写中", color: "var(--purple)", bg: "var(--purple-pale)" },
  completed: { label: "已完成", color: "var(--success)", bg: "var(--success-pale)" },
  failed: { label: "失败", color: "var(--danger)", bg: "var(--danger-pale)" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, color: "var(--muted)", bg: "var(--line)" };
  return (
    <span className="rounded-full px-2 py-px text-xs font-medium" style={{ color: meta.color, background: meta.bg }}>
      {meta.label}
    </span>
  );
}

const SUGGESTIONS = [
  "2026 年中国新能源汽车出口市场的竞争格局与增长驱动因素",
  "AI Agent 在企业软件领域的产品化路径与商业模式",
  "跨境电商供应链的合规风险与应对策略",
];

export function ResearchClient({ initialSourceQuestionId }: { initialSourceQuestionId?: string }) {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // 来源任务问答背景：发起研究时随请求携带，后端注入 Planner 与报告生成
  const [sourceQuestion, setSourceQuestion] = useState<SourceQuestion | null>(null);
  const [loadingSource, setLoadingSource] = useState(Boolean(initialSourceQuestionId));

  // 模式：create（新建）| live（实时执行中/刚完成）| viewing（历史回看）
  const [mode, setMode] = useState<"create" | "live" | "viewing">("create");
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 新建表单
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<"standard" | "deep">("standard");
  const [startError, setStartError] = useState("");

  const { state, streaming, start, stop } = useAgentStream();

  // 研究知识图谱刷新信号：每次研究完成后递增，触发面板重新拉取（本次研究已沉淀入图）
  const [graphRefreshSignal, setGraphRefreshSignal] = useState(0);

  const loadTasks = useCallback(async () => {
    try {
      const json = await apiFetch("/api/v1/research?page=1&pageSize=50");
      if (json.ok) setTasks(json.data.tasks ?? []);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // 深链 ?fromQuestion={id}：加载源任务问答作为研究背景（仅已完成的问答可用）
  useEffect(() => {
    if (!initialSourceQuestionId) return;
    let cancelled = false;
    Promise.resolve().then(async () => {
      try {
        const json = await apiFetch(`/api/v1/ask/${initialSourceQuestionId}`);
        if (cancelled) return;
        if (json.ok && json.data?.status === "completed") {
          const answer = (json.data.answer ?? {}) as { content?: string };
          setSourceQuestion({
            id: json.data.id,
            content: json.data.content,
            answerPreview: (answer.content ?? "").slice(0, 200),
          });
        }
      } catch {
        // 加载失败静默降级为普通新建
      } finally {
        if (!cancelled) setLoadingSource(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialSourceQuestionId]);

  /** 发起深度研究（SSE 实时流） */
  const launch = useCallback(async () => {
    if (question.trim().length < 4) {
      setStartError("研究问题至少 4 个字");
      return;
    }
    setStartError("");
    setMode("live");
    setViewingId(null);
    setDetail(null);

    await start(
      "/api/v1/research",
      {
        question: question.trim(),
        depth,
        // 来源任务问答：其结果（压缩上下文）作为研究背景注入工作流
        ...(sourceQuestion ? { sourceQuestionId: sourceQuestion.id } : {}),
      },
      () => {
        // 完成后刷新任务列表与研究知识图谱（报告已在 live 视图中完整呈现）
        loadTasks();
        setGraphRefreshSignal((s) => s + 1);
      },
    );
  }, [question, depth, start, loadTasks, sourceQuestion]);

  /** 回看历史任务 */
  const openTask = useCallback(async (taskId: string) => {
    stop();
    setMode("viewing");
    setViewingId(taskId);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const json = await apiFetch(`/api/v1/research/${taskId}`);
      if (json.ok) setDetail(json.data);
    } finally {
      setLoadingDetail(false);
    }
  }, [stop]);

  /** 删除任务 */
  const removeTask = useCallback(async (taskId: string) => {
    await fetch(`/api/v1/research/${taskId}`, { method: "DELETE" });
    if (viewingId === taskId) {
      setMode("create");
      setViewingId(null);
      setDetail(null);
    }
    loadTasks();
  }, [viewingId, loadTasks]);

  /** 图谱面板点击历史研究：按 questionId 定位任务并回看 */
  const openByQuestionId = useCallback(
    (questionId: string) => {
      const task = tasks.find((t) => t.questionId === questionId);
      if (task) openTask(task.id);
    },
    [tasks, openTask],
  );

  const answer = detail?.task.answer ?? null;
  const liveActive = mode === "live";

  return (
    <div className="flex h-full gap-5">
      {/* ── 任务列表 ── */}
      <aside className="flex w-80 shrink-0 flex-col gap-3">
        <button
          onClick={() => { stop(); setMode("create"); }}
          className="flex items-center justify-center gap-1.5 rounded-[9px] px-3 py-2 text-xs font-medium transition-transform hover:-translate-y-0.5"
          style={{ background: "var(--purple)", color: "#fff" }}
        >
          <Plus size={14} /> 发起新研究
        </button>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          {loadingList ? (
            <div className="flex justify-center py-10">
              <Loader2 size={20} className="animate-spin" style={{ color: "var(--muted)" }} />
            </div>
          ) : tasks.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs" style={{ color: "var(--muted)" }}>
              暂无研究任务
            </p>
          ) : (
            tasks.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "group rounded-[var(--radius-sm)] border p-3 transition-all hover:-translate-y-0.5",
                )}
                style={{
                  borderColor: viewingId === t.id ? "var(--purple)" : "var(--line)",
                  background: "var(--surface)",
                  boxShadow: viewingId === t.id ? "0 0 0 3px var(--purple-pale)" : undefined,
                }}
              >
                <button onClick={() => openTask(t.id)} className="w-full text-left">
                  <p className="line-clamp-2 text-xs font-medium leading-relaxed" style={{ color: "var(--ink)" }}>
                    {t.question}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <StatusBadge status={t.status} />
                    {t.citationCount > 0 && (
                      <span className="flex items-center gap-0.5 text-xs" style={{ color: "var(--muted)" }}>
                        <ExternalLink size={10} /> {t.citationCount}
                      </span>
                    )}
                    {t.elapsedMs !== null && t.status === "completed" && (
                      <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                        {Math.round(t.elapsedMs / 1000)}s
                      </span>
                    )}
                  </div>
                </button>
                <button
                  onClick={() => removeTask(t.id)}
                  className="mt-1.5 flex items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: "var(--danger)" }}
                  aria-label="删除任务"
                >
                  <Trash2 size={11} /> 删除
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── 主区 ── */}
      <div className="min-w-0 flex-1">
        {liveActive ? (
          /* 实时执行视图 */
          <div className="space-y-5">
            <header className="flex items-center justify-between">
              <div>
                <h1 className="flex items-center gap-2 text-lg font-bold" style={{ color: "var(--ink)" }}>
                  <Telescope size={19} style={{ color: "var(--purple)" }} />
                  深度研究{streaming ? "（执行中）" : ""}
                </h1>
                <p className="mt-0.5 line-clamp-1 text-sm" style={{ color: "var(--muted)" }}>{question}</p>
              </div>
              {streaming && (
                <button
                  onClick={stop}
                  className="flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs transition-colors hover:bg-black/[0.03]"
                  style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                >
                  <XCircle size={13} /> 停止
                </button>
              )}
            </header>

            {state.error && (
              <p className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                {state.error}
              </p>
            )}

            {/* 阶段进度条 */}
            {state.phases.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {state.phases.map((p) => (
                  <span
                    key={`${p.phase}-${p.label}`}
                    className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
                    style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
                  >
                    <CheckCircle2 size={11} /> {p.label}
                  </span>
                ))}
              </div>
            )}

            <AgentTimeline state={state} />

            {/* 流式报告 */}
            {state.answer && (
              <section
                className="rounded-[var(--radius-sm)] border p-6"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <h2 className="mb-3 flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                  <FileText size={15} style={{ color: "var(--purple)" }} />
                  研究报告
                  {!state.done && <Loader2 size={13} className="animate-spin" style={{ color: "var(--purple)" }} />}
                </h2>
                <MarkdownView content={state.answer} />
                {state.done && state.elapsedMs !== null && (
                  <p className="mt-4 border-t pt-3 text-xs" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                    研究完成 · 总耗时 {(state.elapsedMs / 1000).toFixed(1)}s · 引用 {state.citations.length} 条
                  </p>
                )}
              </section>
            )}

            <CitationList citations={state.citations} />
          </div>
        ) : mode === "viewing" && viewingId ? (
          /* 历史回看视图 */
          <div className="space-y-5">
            {loadingDetail ? (
              <div className="flex justify-center py-24">
                <Loader2 size={24} className="animate-spin" style={{ color: "var(--purple)" }} />
              </div>
            ) : detail ? (
              <>
                <header>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={detail.task.status} />
                    {detail.task.completedAt && (
                      <span className="flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
                        <Clock size={11} />
                        {new Date(detail.task.completedAt).toLocaleString("zh-CN")}
                      </span>
                    )}
                  </div>
                  <h1 className="mt-2 text-lg font-bold leading-relaxed" style={{ color: "var(--ink)" }}>
                    {detail.task.question}
                  </h1>
                  {answer?.objective && (
                    <p className="mt-1 text-sm" style={{ color: "var(--ink-soft)" }}>研究目标：{answer.objective}</p>
                  )}
                </header>

                {answer?.error ? (
                  <p className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                    {answer.error}
                  </p>
                ) : (
                  <>
                    {/* 子问题与发现 */}
                    {(answer?.subQuestions ?? []).length > 0 && (
                      <section
                        className="rounded-[var(--radius-sm)] border p-5"
                        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                      >
                        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                          <Sparkles size={14} style={{ color: "var(--purple)" }} />
                          子问题研究发现（{answer?.subQuestions?.length ?? 0}）
                        </h2>
                        <div className="space-y-3">
                          {(answer?.subQuestions ?? []).map((sq, i) => (
                            <details key={sq.id} className="rounded-[8px] border" style={{ borderColor: "var(--line)" }}>
                              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
                                <span className="shrink-0 rounded px-1.5 py-0.5 font-semibold tabular-nums" style={{ background: "var(--purple-pale)", color: "var(--purple)" }}>
                                  {i + 1}
                                </span>
                                <span className="min-w-0 flex-1 font-medium" style={{ color: "var(--ink)" }}>{sq.question}</span>
                                <span className="shrink-0" style={{ color: "var(--muted)" }}>
                                  {sq.findings.length} 条发现 · {sq.searchedQueries.length} 次检索
                                </span>
                              </summary>
                              <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--line)" }}>
                                <ul className="space-y-1.5">
                                  {sq.findings.map((f, j) => (
                                    <li key={j} className="flex gap-1.5 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                                      <span className="shrink-0" style={{ color: "var(--purple)" }}>•</span>
                                      {f}
                                    </li>
                                  ))}
                                </ul>
                                {sq.searchedQueries.length > 0 && (
                                  <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                                    检索词：{sq.searchedQueries.join("；")}
                                  </p>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      </section>
                    )}

                    {/* 研究报告 */}
                    {answer?.content && (
                      <section
                        className="rounded-[var(--radius-sm)] border p-6"
                        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                      >
                        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold" style={{ color: "var(--ink)" }}>
                          <BookOpen size={15} style={{ color: "var(--purple)" }} /> 研究报告
                        </h2>
                        <MarkdownView content={answer.content} />
                        {answer.elapsedMs !== undefined && (
                          <p className="mt-4 border-t pt-3 text-xs" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                            总耗时 {(answer.elapsedMs / 1000).toFixed(1)}s
                          </p>
                        )}
                      </section>
                    )}

                    <CitationList citations={answer?.citations ?? []} />
                  </>
                )}
              </>
            ) : (
              <p className="py-20 text-center text-sm" style={{ color: "var(--muted)" }}>任务不存在</p>
            )}
          </div>
        ) : (
          /* 新建研究视图 */
          <div className="mx-auto max-w-2xl space-y-5 py-8">
            <header className="text-center">
              <div
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{ background: "var(--purple-pale)" }}
              >
                <Telescope size={26} style={{ color: "var(--purple)" }} />
              </div>
              <h1 className="mt-4 text-xl font-bold" style={{ color: "var(--ink)" }}>发起深度研究</h1>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
                Planner 拆解研究计划 → Executor 逐子问题联网检索与深读 → Synthesizer 汇总证据流式成稿，
                全程可视化、每条发现可溯源
              </p>
            </header>

            <section
              className="rounded-[var(--radius-sm)] border p-5"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}
            >
              {/* 来源任务问答背景卡片：研究将在此结论之上向外延展，可移除 */}
              {loadingSource ? (
                <div className="mb-3 flex items-center gap-2 rounded-[8px] border px-3 py-2.5 text-xs" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                  <Loader2 size={12} className="animate-spin" /> 正在加载任务问答背景…
                </div>
              ) : sourceQuestion && (
                <div
                  className="mb-3 rounded-[8px] border px-3 py-2.5"
                  style={{ borderColor: "var(--purple)", background: "var(--purple-pale)" }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--purple)" }}>
                      <MessageSquareText size={12} /> 来自任务问答（其结论将作为研究背景）
                    </p>
                    <button
                      onClick={() => setSourceQuestion(null)}
                      className="shrink-0 rounded p-0.5 transition-colors hover:bg-black/[0.05]"
                      style={{ color: "var(--muted)" }}
                      aria-label="移除问答背景"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs font-medium" style={{ color: "var(--ink)" }}>{sourceQuestion.content}</p>
                  {sourceQuestion.answerPreview && (
                    <p className="mt-1 line-clamp-2 text-xs" style={{ color: "var(--ink-soft)" }}>
                      {sourceQuestion.answerPreview}
                    </p>
                  )}
                </div>
              )}

              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                placeholder={
                  sourceQuestion
                    ? "基于上方问答结论，补充你的研究方向（例如：TikTok 竞价成本上涨的外部原因与应对策略）"
                    : "描述你的研究问题（例如：2026 年中国新能源汽车出口市场的竞争格局与增长驱动因素）"
                }
                className="w-full resize-y rounded-[8px] border p-3 text-sm outline-none focus:border-[var(--purple)]"
                style={{ borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink)" }}
              />

              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>研究深度：</span>
                {(["standard", "deep"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDepth(d)}
                    className="rounded-[8px] border px-3 py-1.5 text-xs transition-colors"
                    style={{
                      borderColor: depth === d ? "var(--purple)" : "var(--line)",
                      background: depth === d ? "var(--purple-pale)" : "var(--paper)",
                      color: depth === d ? "var(--purple)" : "var(--ink-soft)",
                    }}
                  >
                    {d === "standard" ? "标准（每子问题深读 2 页）" : "深入（每子问题深读 3 页）"}
                  </button>
                ))}
              </div>

              {startError && (
                <p className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{startError}</p>
              )}

              <button
                onClick={launch}
                disabled={streaming}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-[9px] py-2.5 text-sm font-medium transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                style={{ background: "var(--purple)", color: "#fff" }}
              >
                {streaming ? <Loader2 size={15} className="animate-spin" /> : <Telescope size={15} />}
                {streaming ? "研究中..." : "开始深度研究"}
              </button>
            </section>

            {/* 建议问题（带问答背景时隐藏，避免覆盖用户研究方向） */}
            {!sourceQuestion && (
              <section>
                <h3 className="mb-2 text-xs font-bold" style={{ color: "var(--muted)" }}>试试这些研究方向</h3>
                <div className="space-y-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setQuestion(s)}
                      className="w-full rounded-[8px] border px-3 py-2.5 text-left text-xs transition-all hover:-translate-y-0.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--ink-soft)" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* 研究知识图谱：历史研究沉淀（Understand-Anything 融合），点击可回看关联研究 */}
            <GraphPanel refreshSignal={graphRefreshSignal} onOpenQuestion={openByQuestionId} />
          </div>
        )}
      </div>
    </div>
  );
}
