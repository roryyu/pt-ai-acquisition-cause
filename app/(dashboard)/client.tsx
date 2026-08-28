"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  MessageSquareText,
  PenTool,
  Telescope,
  ArrowRight,
  Plus,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DashboardStats {
  stats: { totalQuestions: number; totalInsights: number; totalResearch: number };
  recentQuestions: Array<{ id: string; content: string; status: string; createdAt: string }>;
  recentInsights: Array<{ id: string; title: string; kind: string; status: string; createdAt: string }>;
}

/** 洞察文档类型中文标签 */
const KIND_LABEL: Record<string, string> = { report: "报告", board: "看板", digest: "日报" };

export function WorkspaceClient() {
  const [data, setData] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/v1/dashboard/stats");
      const json = await res.json();
      if (json.ok) {
        setData(json.data);
      } else {
        setError(json.error?.message ?? "加载失败");
      }
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(refresh);
  }, [refresh]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20" role="status">
        <div className="text-sm" style={{ color: "var(--muted)" }}>加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center" role="alert">
        <p className="text-sm" style={{ color: "var(--danger)" }}>{error}</p>
        <button
          onClick={refresh}
          className="mt-4 rounded-[10px] px-4 py-2 text-sm text-white transition-colors"
          style={{ background: "var(--purple)" }}
        >
          重试
        </button>
      </div>
    );
  }

  const stats = data?.stats ?? { totalQuestions: 0, totalInsights: 0, totalResearch: 0 };

  return (
    <div className="space-y-8">
      {/* 页面标题 */}
      <div>
        <h1
          className="text-[clamp(28px,3vw,40px)] font-semibold leading-tight tracking-tight"
          style={{ color: "var(--ink)" }}
        >
          工作台
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          欢迎回来，这里是您的工作概览
        </p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<MessageSquareText size={20} />}
          label="提问总数"
          value={stats.totalQuestions}
          color="var(--purple)"
          bgColor="var(--purple-pale)"
        />
        <StatCard
          icon={<PenTool size={20} />}
          label="洞察画布"
          value={stats.totalInsights}
          color="var(--success)"
          bgColor="var(--success-pale)"
        />
        <StatCard
          icon={<Telescope size={20} />}
          label="研究任务"
          value={stats.totalResearch}
          color="var(--warning)"
          bgColor="var(--warning-pale)"
        />
      </div>

      {/* 快捷入口 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickAction
          href="/ask"
          icon={<Plus size={20} />}
          label="新建提问"
          description="用自然语言分析业务问题"
          color="var(--purple)"
        />
        <QuickAction
          href="/insights"
          icon={<PenTool size={20} />}
          label="洞察画布"
          description="报告 / 看板 / 日报统一画布编辑"
          color="var(--success)"
        />
        <QuickAction
          href="/research"
          icon={<Telescope size={20} />}
          label="深度研究"
          description="多智能体协同的深度分析"
          color="var(--warning)"
        />
      </div>

      {/* 双栏：最近提问 + 最近报告 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 最近提问 */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
              最近提问
            </h2>
            <Link
              href="/ask"
              className="flex items-center gap-1 text-xs transition-colors hover:underline"
              style={{ color: "var(--purple)" }}
            >
              查看全部 <ArrowRight size={12} />
            </Link>
          </div>
          <div
            className="overflow-hidden rounded-[var(--radius-sm)] border"
            style={{ borderColor: "var(--line)", background: "var(--surface)" }}
          >
            {data?.recentQuestions?.length ? (
              <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
                {data.recentQuestions.map((q) => (
                  <li key={q.id}>
                    <Link
                      href={`/ask?id=${q.id}`}
                      className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-black/[0.02]"
                    >
                      <div className="flex-1 truncate">
                        <p className="truncate text-sm" style={{ color: "var(--ink)" }}>
                          {q.content}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <Clock size={11} style={{ color: "var(--muted)" }} />
                          <span className="text-xs" style={{ color: "var(--muted)" }}>
                            {formatTime(q.createdAt)}
                          </span>
                          <StatusBadge status={q.status} />
                        </div>
                      </div>
                      <ArrowRight size={14} style={{ color: "var(--muted)" }} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState text="暂无提问记录" />
            )}
          </div>
        </section>

        {/* 最近洞察 */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
              最近洞察
            </h2>
            <Link
              href="/insights"
              className="flex items-center gap-1 text-xs transition-colors hover:underline"
              style={{ color: "var(--purple)" }}
            >
              查看全部 <ArrowRight size={12} />
            </Link>
          </div>
          <div
            className="overflow-hidden rounded-[var(--radius-sm)] border"
            style={{ borderColor: "var(--line)", background: "var(--surface)" }}
          >
            {data?.recentInsights?.length ? (
              <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
                {data.recentInsights.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/insights/${r.id}`}
                      className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-black/[0.02]"
                    >
                      <div className="flex-1 truncate">
                        <p className="truncate text-sm" style={{ color: "var(--ink)" }}>
                          {r.title}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          <Clock size={11} style={{ color: "var(--muted)" }} />
                          <span className="text-xs" style={{ color: "var(--muted)" }}>
                            {formatTime(r.createdAt)}
                          </span>
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
                          >
                            {KIND_LABEL[r.kind] ?? r.kind}
                          </span>
                        </div>
                      </div>
                      <ArrowRight size={14} style={{ color: "var(--muted)" }} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState text="暂无洞察文档" />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ─── 子组件 ─── */

function StatCard({
  icon,
  label,
  value,
  color,
  bgColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  bgColor: string;
}) {
  return (
    <div
      className="flex items-center gap-4 rounded-[var(--radius-sm)] border p-5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div
        className="flex h-11 w-11 items-center justify-center rounded-[10px]"
        style={{ background: bgColor, color }}
      >
        {icon}
      </div>
      <div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {label}
        </p>
        <p className="tabular-nums text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          {value}
        </p>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  icon,
  label,
  description,
  color,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  description: string;
  color: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-[var(--radius-sm)] border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
        style={{ background: color, color: "#fff" }}
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>
          {label}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
          {description}
        </p>
      </div>
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    completed: { label: "已完成", cls: "status-dot--success" },
    analyzing: { label: "分析中", cls: "status-dot--warning" },
    failed: { label: "失败", cls: "status-dot--danger" },
    queued: { label: "排队中", cls: "status-dot--default" },
    draft: { label: "草稿", cls: "status-dot--default" },
    published: { label: "已发布", cls: "status-dot--success" },
    archived: { label: "已归档", cls: "status-dot--default" },
  };
  const info = map[status] ?? { label: status, cls: "status-dot--default" };

  return (
    <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--muted)" }}>
      <span className={cn("status-dot", info.cls)} />
      {info.label}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10">
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        {text}
      </p>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}
