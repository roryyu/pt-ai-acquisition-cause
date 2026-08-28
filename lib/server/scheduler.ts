/**
 * 定时任务调度器（抽象层）
 * 不在 Next 进程内常驻定时器：由 POST /api/v1/schedules/run 驱动
 * （UI「立即执行」按钮 + 外部 cron 定时 curl），扫描到期任务并通过投递渠道执行。
 */
import { CronExpressionParser } from "cron-parser";
import { prisma } from "@/lib/db";
import { deliver, latestExportPng } from "@/lib/server/delivery";
import { extractTextFromSnapshot } from "@/lib/server/insights/snapshot";

/** 校验 cron 表达式合法性（标准 5 段） */
export function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/** 计算下次执行时间；表达式非法返回 null */
export function nextRunDate(expr: string, from: Date = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(expr, { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

/** 判断任务是否到期（nextRunAt <= now 且启用） */
export function isJobDue(job: { enabled: boolean; nextRunAt: Date | null }, now: Date): boolean {
  return job.enabled && job.nextRunAt !== null && job.nextRunAt.getTime() <= now.getTime();
}

/** 单任务执行结果 */
export interface JobRunResult {
  jobId: string;
  docId: string;
  action: string;
  status: "sent" | "failed";
  detail: unknown;
}

/**
 * 扫描并执行所有到期任务
 * @returns 每个任务的执行结果
 */
export async function runDueJobs(now: Date = new Date()): Promise<JobRunResult[]> {
  const dueJobs = await prisma.scheduleJob.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    include: { doc: { select: { id: true, title: true, snapshot: true } } },
  });

  const results: JobRunResult[] = [];
  for (const job of dueJobs) {
    let status: "sent" | "failed" = "failed";
    let detail: unknown = { error: "执行异常" };
    try {
      const markdown = extractTextFromSnapshot(job.doc.snapshot);
      const imagePath = await latestExportPng(job.doc.id);

      if (job.action === "email") {
        // 定时邮件：正文取画布文本，附件取最近一次导出 PNG（若有）
        const recipients = Array.isArray(job.recipients)
          ? (job.recipients as unknown[]).filter((r): r is string => typeof r === "string")
          : [];
        const res = await deliver("email", {
          docId: job.doc.id,
          title: job.doc.title,
          recipients,
          markdown: markdown || undefined,
          ...(imagePath ? { imagePath } : {}),
        });
        status = res.status as "sent" | "failed";
        detail = res.detail;
      } else {
        // 定时导出：记录最近一次导出图片（画布 PNG 由客户端渲染，服务端无法重绘）
        const res = await deliver("image", {
          docId: job.doc.id,
          title: job.doc.title,
          recipients: [],
          ...(imagePath ? { imagePath } : {}),
        });
        status = res.status as "sent" | "failed";
        detail = imagePath
          ? res.detail
          : { note: "画布尚未导出过图片，请先在画布页手动导出" };
      }
    } catch (error) {
      detail = { error: error instanceof Error ? error.message : String(error) };
    }

    // 回填执行时间并推进下次执行点
    const next = nextRunDate(job.cronExpr, now);
    await prisma.scheduleJob.update({
      where: { id: job.id },
      data: { lastRunAt: now, nextRunAt: next },
    });

    results.push({ jobId: job.id, docId: job.doc.id, action: job.action, status, detail });
  }

  return results;
}
