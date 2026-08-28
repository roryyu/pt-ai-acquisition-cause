/**
 * 洞察画布模块单元测试：
 * 1. 绑定 payload 提取（问答 / 深度研究）
 * 2. 定时任务 cron 解析与到期判断
 * 3. 邮件投递抽象层落盘行为
 * 4. snapshot 文本提取（映射 / 数组两种 store 结构）
 * 5. 画布绑定源状态助手（含 deleted 源已删除收敛态）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// 隔离 DB 与环境变量依赖（与 datasources.test.ts 同模式）
vi.mock("@/lib/db", () => ({
  prisma: {},
  Prisma: {},
}));
vi.mock("@/lib/env", () => ({
  env: { DATABASE_URL: "postgresql://localhost:5432/test?schema=cause" },
}));

import { extractFromQuestion, extractFromResearch } from "@/lib/server/insights/extract";
import { isValidCron, nextRunDate, isJobDue } from "@/lib/server/scheduler";
import { emailChannel } from "@/lib/server/delivery/email-channel";
import { extractTextFromSnapshot } from "@/lib/server/insights/snapshot";
import { isSourceRunning, isSourceDeleted, sourceStatusLabel } from "@/lib/canvas/types";

describe("绑定 payload 提取 extractFromQuestion", () => {
  it("含图表的回答提取为 chart 类并透传 charts", () => {
    const chart = { type: "line", title: "GMV 趋势", data: [{ x: 1, y: 2 }] };
    const { payload, sourceStatus } = extractFromQuestion({
      id: "question_1",
      content: "近 30 天 GMV 趋势如何？",
      status: "completed",
      answer: { content: "整体上升", charts: [chart], tables: [], citations: [] },
    });
    expect(sourceStatus).toBe("completed");
    expect(payload.kind).toBe("chart");
    expect(payload.title).toBe("近 30 天 GMV 趋势如何？");
    expect(payload.charts).toHaveLength(1);
    expect(payload.text).toBe("整体上升");
  });

  it("无图表的回答提取为 text 类", () => {
    const { payload } = extractFromQuestion({
      id: "question_2",
      content: "为什么转化率下降？",
      status: "completed",
      answer: { content: "主因是渠道结构变化" },
    });
    expect(payload.kind).toBe("text");
    expect(payload.text).toBe("主因是渠道结构变化");
  });

  it("运行中的问题仍返回占位 payload 并透传运行状态", () => {
    const { payload, sourceStatus } = extractFromQuestion({
      id: "question_3",
      content: "分析中...",
      status: "analyzing",
      answer: null,
    });
    expect(sourceStatus).toBe("analyzing");
    expect(payload.kind).toBe("text");
    expect(payload.charts).toBeUndefined();
  });

  it("过滤结构不合法的图表项", () => {
    const { payload } = extractFromQuestion({
      id: "question_4",
      content: "q",
      status: "completed",
      answer: { charts: [{ noData: true }, { data: [] }], tables: [{ columns: [] }] },
    });
    // 无 data 数组的被过滤；tables 缺 rows 也被过滤
    expect(payload.charts).toHaveLength(1);
    expect(payload.tables).toBeUndefined();
  });
});

describe("绑定 payload 提取 extractFromResearch", () => {
  it("优先取关联 Question.answer 的正文与引用", () => {
    const { payload, sourceStatus } = extractFromResearch(
      { id: "task_1", status: "completed", output: { report: "fallback" }, citations: [] },
      {
        id: "question_r",
        content: "竞品渠道策略研究",
        status: "completed",
        answer: {
          kind: "deep_research",
          content: "研究报告正文",
          citations: [{ title: "来源 A", url: "https://a.example" }],
        },
      },
    );
    expect(sourceStatus).toBe("completed");
    expect(payload.kind).toBe("research");
    expect(payload.title).toBe("竞品渠道策略研究");
    expect(payload.text).toBe("研究报告正文");
    expect(payload.citations).toHaveLength(1);
  });

  it("无关联问答时回退 task.output.report", () => {
    const { payload } = extractFromResearch(
      { id: "task_2", status: "writing", output: { report: "任务输出正文" }, citations: [] },
      null,
    );
    expect(payload.kind).toBe("research");
    expect(payload.title).toBe("深度研究");
    expect(payload.text).toBe("任务输出正文");
  });
});

describe("定时任务 cron 解析与到期判断", () => {
  it("isValidCron 校验标准 5 段表达式", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("0 9 *")).toBe(false);
  });

  it("nextRunDate 基于给定时间计算下次执行点", () => {
    const from = new Date("2026-06-01T08:00:00");
    const next = nextRunDate("0 9 * * *", from);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe(new Date("2026-06-01T09:00:00").toISOString());
    expect(nextRunDate("bad cron", from)).toBeNull();
  });

  it("isJobDue 仅在启用且到期时为真", () => {
    const now = new Date("2026-06-01T09:00:00");
    expect(isJobDue({ enabled: true, nextRunAt: new Date("2026-06-01T08:59:00") }, now)).toBe(true);
    expect(isJobDue({ enabled: true, nextRunAt: new Date("2026-06-01T09:01:00") }, now)).toBe(false);
    expect(isJobDue({ enabled: false, nextRunAt: new Date("2026-06-01T08:59:00") }, now)).toBe(false);
    expect(isJobDue({ enabled: true, nextRunAt: null }, now)).toBe(false);
  });
});

describe("邮件投递抽象层落盘行为", () => {
  it("SMTP 未配置时落盘邮件内容并返回 mock sent", async () => {
    const res = await emailChannel.deliver({
      docId: "insight_test",
      title: "测试画布",
      recipients: ["alice@example.com"],
      markdown: "## 正文摘要",
    });
    expect(res.status).toBe("sent");
    expect(res.mock).toBe(true);
    const file = (res.detail as { file?: string }).file;
    expect(file).toMatch(/^\.deliveries\/email-insight_test-\d+\.md$/);
    expect(existsSync(join(process.cwd(), file!))).toBe(true);
  });

  it("收件人为空时直接返回 failed", async () => {
    const res = await emailChannel.deliver({
      docId: "insight_test",
      title: "测试",
      recipients: [],
    });
    expect(res.status).toBe("failed");
    expect((res.detail as { error?: string }).error).toContain("收件人");
  });
});

describe("snapshot 文本提取", () => {
  const shapeRecords = [
    { typeName: "shape", type: "text", props: { text: "画布标注文字" } },
    { typeName: "shape", type: "note", props: { text: "便签内容" } },
    {
      typeName: "shape",
      type: "live-content",
      props: { payload: { kind: "text", title: "实时卡片标题", text: "实时卡片正文" } },
    },
    { typeName: "document", id: "document:document" },
  ];

  it("支持编辑器快照的映射形式 store", () => {
    const snapshot = {
      store: Object.fromEntries(shapeRecords.map((r, i) => [`rec_${i}`, r])),
    };
    const text = extractTextFromSnapshot(snapshot);
    expect(text).toContain("画布标注文字");
    expect(text).toContain("【便签】便签内容");
    expect(text).toContain("## 实时卡片标题");
    expect(text).toContain("实时卡片正文");
  });

  it("支持迁移快照的数组形式 store", () => {
    const text = extractTextFromSnapshot({ store: shapeRecords });
    expect(text).toContain("画布标注文字");
    expect(text).toContain("## 实时卡片标题");
  });

  it("非法输入返回空字符串", () => {
    expect(extractTextFromSnapshot(null)).toBe("");
    expect(extractTextFromSnapshot({})).toBe("");
    expect(extractTextFromSnapshot({ store: "bad" })).toBe("");
  });
});

describe("画布绑定源状态助手", () => {
  it("运行中状态判定为 running", () => {
    expect(isSourceRunning("analyzing")).toBe(true);
    expect(isSourceRunning("collecting")).toBe(true);
  });

  it("终态与已删除均不再视为运行中", () => {
    expect(isSourceRunning("completed")).toBe(false);
    expect(isSourceRunning("failed")).toBe(false);
    expect(isSourceRunning("unknown")).toBe(false);
    expect(isSourceRunning("deleted")).toBe(false);
  });

  it("deleted 收敛态：源删除后绑定不再刷新，徽标显示源已删除", () => {
    expect(isSourceDeleted("deleted")).toBe(true);
    expect(isSourceDeleted("completed")).toBe(false);
    expect(isSourceDeleted("analyzing")).toBe(false);
    expect(sourceStatusLabel("deleted")).toBe("源已删除");
  });
});
