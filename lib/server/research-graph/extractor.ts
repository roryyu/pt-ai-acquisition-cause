import { chatCompletion } from "@/lib/server/model-gateway";
import { GRAPH_EXTRACT_PROMPT } from "@/lib/server/agents/prompts";
import type { SubQuestionResult } from "@/lib/server/agents/deep-research";
import { parseGraphPatch, type GraphPatch } from "./types";

/**
 * 图谱抽取（设计文档 4.1，对应 UA 的 article-analyzer/file-analyzer 角色）
 *
 * 报告完成后经 LLM 从「研究问题 + 子问题发现 + 报告」中抽取实体/主题/关系，
 * 产出图谱补丁；解析失败返回 null，上层静默跳过（图谱不可用不影响研究产出）。
 * 补丁解析纯函数见 types.ts::parseGraphPatch（便于单测，不依赖模型网关）。
 */

/** 组装抽取输入：研究问题/目标 + 子问题发现（≤6000 字）+ 报告前 3000 字 */
export function composeExtractInput(
  question: string,
  objective: string,
  subResults: SubQuestionResult[],
  report: string,
): string {
  const evidenceBlock = subResults
    .map((r) => `【${r.question}】\n${r.findings.slice(0, 4).map((f) => `- ${f}`).join("\n")}`)
    .join("\n\n")
    .slice(0, 6000);
  return `研究问题：${question}\n研究目标：${objective}\n\n## 各子问题研究发现（含引用编号）\n${evidenceBlock}\n\n## 研究报告（节选）\n${report.slice(0, 3000)}`;
}

/**
 * LLM 抽取图谱补丁；失败/解析异常返回 null（静默降级）。
 */
export async function extractGraphPatch(
  question: string,
  objective: string,
  subResults: SubQuestionResult[],
  report: string,
): Promise<GraphPatch | null> {
  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: GRAPH_EXTRACT_PROMPT },
        { role: "user", content: composeExtractInput(question, objective, subResults, report) },
      ],
      { temperature: 0.1, maxTokens: 2048 },
    );
    return parseGraphPatch(raw);
  } catch {
    return null;
  }
}
