import { describe, expect, it } from "vitest";
import {
  CONTEXT_SUMMARY_ANSWER_LIMIT,
  CONTEXT_SUMMARY_MAX_LENGTH,
  composeContextSummaryInput,
  fallbackContextSummary,
} from "@/lib/server/agents/prompts";

/**
 * 多轮追问上下文压缩（纯函数层）
 * LLM 压缩调用位于 app/api/v1/ask/route.ts（依赖网关与 DB，走集成验证）
 */
describe("多轮追问上下文压缩", () => {
  describe("composeContextSummaryInput", () => {
    it("包含已有摘要、本轮问题与本轮回答", () => {
      const input = composeContextSummaryInput("上轮结论：TikTok CPI 上涨", "为什么上涨？", "因 6 月竞价加剧");
      expect(input).toContain("上轮结论：TikTok CPI 上涨");
      expect(input).toContain("为什么上涨？");
      expect(input).toContain("因 6 月竞价加剧");
    });

    it("无已有摘要时标记首轮（含空白摘要同样视为无）", () => {
      expect(composeContextSummaryInput(null, "q", "a")).toContain("（无，这是首轮问答）");
      expect(composeContextSummaryInput("   ", "q", "a")).toContain("（无，这是首轮问答）");
    });

    it("超长回答截断到上限，避免撑爆压缩调用", () => {
      const longAnswer = "数".repeat(CONTEXT_SUMMARY_ANSWER_LIMIT + 500);
      const input = composeContextSummaryInput(null, "q", longAnswer);
      const answerSection = input.split("本轮回答：\n")[1] ?? "";
      expect(answerSection.startsWith("数".repeat(CONTEXT_SUMMARY_ANSWER_LIMIT))).toBe(true);
      expect(answerSection.includes("数".repeat(CONTEXT_SUMMARY_ANSWER_LIMIT + 1))).toBe(false);
    });
  });

  describe("fallbackContextSummary", () => {
    it("拼接已有摘要与本轮问答", () => {
      const summary = fallbackContextSummary("旧摘要", "X 渠道 FD 为何下降？", "按市场下钻发现…");
      expect(summary).toContain("旧摘要");
      expect(summary).toContain("问：X 渠道 FD 为何下降？");
      expect(summary).toContain("答：按市场下钻发现…");
    });

    it("空摘要时不产生多余段落", () => {
      const summary = fallbackContextSummary(null, "q1", "a1");
      expect(summary.startsWith("问：q1")).toBe(true);
    });

    it("总长度受最大长度约束", () => {
      const summary = fallbackContextSummary("摘".repeat(800), "问".repeat(500), "答".repeat(1000));
      expect(summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_LENGTH);
    });
  });
});
