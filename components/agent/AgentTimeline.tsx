"use client";

import { useState } from "react";
import {
  CheckCircle2, XCircle, Loader2, Wrench, ExternalLink,
  Brain, Database, Globe, ShieldCheck, Sparkles, Compass, GitCompareArrows,
} from "lucide-react";
import type { AgentStreamState, TimelineStep } from "@/lib/agent-events";

/**
 * Agent 推理过程时间线：phase 分组 + step 节点 + 工具调用详情
 * 完整可视化多 Agent 工作流的每一步动作
 */

const AGENT_META: Record<string, { label: string; icon: typeof Brain; color: string }> = {
  supervisor: { label: "Supervisor", icon: Compass, color: "#523b8f" },
  data_analyst: { label: "数据分析师", icon: Database, color: "#176e53" },
  researcher: { label: "研究员", icon: Globe, color: "#875600" },
  critic: { label: "Critic 校验", icon: ShieldCheck, color: "#9b3141" },
  synthesizer: { label: "综合分析师", icon: Sparkles, color: "#523b8f" },
  assistant: { label: "AI 助手", icon: Brain, color: "#523b8f" },
  worker: { label: "Worker", icon: Wrench, color: "#706b79" },
};

const TOOL_ICON: Record<string, typeof Wrench> = {
  sql_query: Database,
  inspect_schema: Database,
  show_table: Database,
  generate_chart: Sparkles,
  web_search: Globe,
  fetch_page: Globe,
  record_finding: Brain,
  // 深度研究经算子注册表调度的研究算子（design.md 5.2.2）
  search: Globe,
  extract: Brain,
  compare: GitCompareArrows,
};

export function AgentTimeline({ state }: { state: AgentStreamState }) {
  const steps = state.steps;
  if (steps.length === 0 && state.phases.length === 0) return null;

  return (
    <div className="rounded-[var(--radius-sm)] border" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--line)" }}>
        <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--ink)" }}>
          <Brain size={15} style={{ color: "var(--purple)" }} />
          Agent 推理过程
          {!state.done && <Loader2 size={13} className="animate-spin" style={{ color: "var(--purple)" }} />}
        </h3>
      </div>

      {/* 研究计划（深度研究任务） */}
      {state.plan && (
        <div className="mx-4 mt-3 rounded-[8px] border p-3" style={{ borderColor: "var(--purple-pale)", background: "var(--purple-pale)" }}>
          <p className="text-xs font-semibold" style={{ color: "var(--purple)" }}>
            研究计划 · {state.plan.subQuestions.length} 个子问题
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--ink-soft)" }}>{state.plan.objective}</p>
          <ol className="mt-2 space-y-1">
            {state.plan.subQuestions.map((sq, i) => (
              <li key={sq.id} className="flex gap-2 text-xs" style={{ color: "var(--ink-soft)" }}>
                <span className="shrink-0 font-semibold" style={{ color: "var(--purple)" }}>{i + 1}.</span>
                <span>{sq.question}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <ol className="space-y-0 px-4 py-3">
        {steps.map((step, i) => (
          <TimelineStepItem key={step.stepId} step={step} isLast={i === steps.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function TimelineStepItem({ step, isLast }: { step: TimelineStep; isLast: boolean }) {
  const meta = AGENT_META[step.agent] ?? AGENT_META.worker!;
  const Icon = meta.icon;
  const [open, setOpen] = useState(false);

  const statusIcon =
    step.status === "done" ? (
      <CheckCircle2 size={14} style={{ color: "var(--success)" }} />
    ) : step.status === "error" ? (
      <XCircle size={14} style={{ color: "var(--danger)" }} />
    ) : (
      <Loader2 size={14} className="animate-spin" style={{ color: "var(--purple)" }} />
    );

  return (
    <li className="relative flex gap-2.5 pb-3">
      {!isLast && (
        <span
          className="absolute left-[7px] top-5 h-full w-px"
          style={{ background: "var(--line)" }}
          aria-hidden
        />
      )}
      <span
        className="z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
        style={{ background: "var(--surface)", border: `1.5px solid ${meta.color}` }}
      >
        <Icon size={9} style={{ color: meta.color }} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold" style={{ color: meta.color }}>
            {meta.label}
          </span>
          <span className="text-xs" style={{ color: "var(--ink-soft)" }}>{step.label}</span>
          {statusIcon}
        </div>

        {step.detail && (
          <p className="mt-0.5 line-clamp-2 text-xs" style={{ color: "var(--muted)" }}>
            {step.detail}
          </p>
        )}

        {step.tools.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {step.tools.map((tool, i) => (
              <ToolCallItem key={i} tool={tool} onToggle={() => setOpen(!open)} expanded={open} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function ToolCallItem({
  tool,
  onToggle,
  expanded,
}: {
  tool: { tool: string; input: unknown; summary?: string; elapsedMs?: number };
  onToggle: () => void;
  expanded: boolean;
}) {
  const ToolIcon = TOOL_ICON[tool.tool] ?? Wrench;
  const inputPreview = summarizeInput(tool.tool, tool.input);

  return (
    <div className="rounded-md border text-xs" style={{ borderColor: "var(--line)" }}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-black/[0.02]"
      >
        <ToolIcon size={12} style={{ color: "var(--muted)" }} className="shrink-0" />
        <span className="font-medium" style={{ color: "var(--ink-soft)" }}>{toolName(tool.tool)}</span>
        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--muted)" }}>
          {inputPreview}
        </span>
        {tool.elapsedMs !== undefined && (
          <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
            {tool.elapsedMs}ms
          </span>
        )}
        {tool.summary && (
          <span className="shrink-0" style={{ color: "var(--success)" }}>✓</span>
        )}
      </button>
      {expanded && (
        <div className="border-t px-2 py-1.5" style={{ borderColor: "var(--line)" }}>
          {tool.summary && (
            <p className="mb-1" style={{ color: "var(--ink-soft)" }}>结果：{tool.summary}</p>
          )}
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/[0.03] p-2 text-[11px]"
            style={{ color: "var(--muted)" }}
          >
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function toolName(tool: string): string {
  const map: Record<string, string> = {
    sql_query: "SQL 查询",
    inspect_schema: "表结构",
    show_table: "展示表格",
    generate_chart: "生成图表",
    web_search: "搜索",
    fetch_page: "抓取",
    record_finding: "记录发现",
    search: "多源检索算子",
    extract: "信息抽取算子",
    compare: "多源对比算子",
  };
  return map[tool] ?? tool;
}

function summarizeInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (tool) {
    case "sql_query":
      return String(obj.sql ?? "").replace(/\s+/g, " ").slice(0, 90);
    case "web_search":
    case "search":
      return `“${String(obj.query ?? "")}”`;
    case "fetch_page":
      return String(obj.url ?? "").slice(0, 70);
    case "extract":
      return String(obj.url ?? "").slice(0, 70);
    case "compare":
      return `「${String(obj.topic ?? "")}」多源比对`;
    case "record_finding":
      return String(obj.finding ?? "").slice(0, 70);
    case "generate_chart":
      return `${obj.chartType ?? ""}「${obj.title ?? ""}」`;
    case "inspect_schema":
      return obj.table ? `表 ${String(obj.table)}` : "全部表";
    default:
      return JSON.stringify(obj).slice(0, 70);
  }
}

/** 引用来源列表 */
export function CitationList({ citations }: { citations: Array<{ no: number; title: string; url: string }> }) {
  if (citations.length === 0) return null;
  return (
    <div className="rounded-[var(--radius-sm)] border p-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <h3 className="mb-2 text-sm font-semibold" style={{ color: "var(--ink)" }}>
        引用来源（{citations.length}）
      </h3>
      <ol className="space-y-1.5">
        {citations.map((c) => (
          <li key={c.no} className="flex items-start gap-2 text-xs">
            <span
              className="mt-px shrink-0 rounded px-1.5 py-0.5 font-semibold tabular-nums"
              style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
            >
              {c.no}
            </span>
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 break-all underline decoration-dotted underline-offset-2 transition-colors hover:opacity-75"
              style={{ color: "var(--ink-soft)" }}
              title={c.url}
            >
              {c.title || c.url}
              <ExternalLink size={10} className="ml-1 inline shrink-0" />
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
