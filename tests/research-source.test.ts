import { describe, expect, it } from "vitest";
import { researchSourceContextBlock } from "@/lib/server/agents/prompts";

/**
 * 任务问答 → 深度研究链路的来源背景块（纯函数层）
 * 注入点：deep-research.ts 的 Planner 与报告生成（依赖网关，走集成验证）
 */
describe("researchSourceContextBlock", () => {
  it("优先使用压缩上下文摘要作为背景结论", () => {
    const block = researchSourceContextBlock({
      question: "TikTok 的 CPI 为什么上涨？",
      contextSummary: "用户关注 TikTok CPI 上涨，已确认 6 月起竞价加剧",
      answerContent: "（长篇原始回答…".repeat(50),
    });
    expect(block).toContain("用户此前的问题：TikTok 的 CPI 为什么上涨？");
    expect(block).toContain("用户关注 TikTok CPI 上涨，已确认 6 月起竞价加剧");
    expect(block).not.toContain("长篇原始回答");
  });

  it("无摘要时截取回答原文（上限 800 字）", () => {
    const longAnswer = "数".repeat(1200);
    const block = researchSourceContextBlock({
      question: "q",
      contextSummary: null,
      answerContent: longAnswer,
    });
    expect(block).toContain("数".repeat(800));
    expect(block).not.toContain("数".repeat(801));
  });

  it("摘要为空白字符串时回退回答原文", () => {
    const block = researchSourceContextBlock({
      question: "q",
      contextSummary: "   ",
      answerContent: "结论 A",
    });
    expect(block).toContain("结论 A");
  });

  it("无任何可用内容时返回空串（不注入）", () => {
    expect(researchSourceContextBlock({ question: "q", contextSummary: null, answerContent: "" })).toBe("");
    expect(researchSourceContextBlock({ question: "q", contextSummary: " ", answerContent: null })).toBe("");
  });
});
