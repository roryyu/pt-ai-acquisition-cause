import { z } from "zod";
import { chatCompletion } from "@/lib/server/model-gateway";
import { webSearch, fetchPage, type SearchResult } from "@/lib/server/connectors/web";
import type { OperatorMeta, OperatorRunResult } from "./data-operators";

/**
 * 研究算子（design.md 5.2.2）
 *
 * 六个研究算子，构建"检索 → 抽取 → 摘要 → 对比 → 溯源 → 写作"研究流水线：
 * - SearchOp     多源检索（互联网搜索）
 * - ExtractOp    关键信息抽取（LLM）
 * - SummarizeOp  内容摘要（LLM）
 * - CompareOp    多源对比（LLM）
 * - CitationOp   引用溯源（结构化）
 * - WriteOp      报告段落生成（LLM）
 */

// ─── SearchOp：多源检索 ───────────────────────────────────────────────────────

export const SearchOpMeta: OperatorMeta = {
  id: "search",
  name: "多源检索",
  category: "research",
  description: "对研究问题执行互联网搜索，返回结构化结果（标题/链接/摘要），是研究流水线的第一步",
  engine: "sql",
  params: [
    { name: "query", label: "检索问题", type: "string", required: true, placeholder: "例如：2026 中国电商行业趋势" },
    { name: "maxResults", label: "结果数量", type: "number", required: false, defaultValue: 6 },
  ],
};

const SearchInput = z.object({
  query: z.string().min(1).max(300),
  maxResults: z.coerce.number().int().min(1).max(10).default(6),
});

export async function runSearchOp(input: z.infer<typeof SearchInput>): Promise<OperatorRunResult & { results?: SearchResult[] }> {
  const start = Date.now();
  try {
    const results = await webSearch(input.query, input.maxResults);
    return {
      ok: results.length > 0,
      operatorId: "search",
      columns: ["title", "url", "snippet"],
      rows: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      rowCount: results.length,
      elapsedMs: Date.now() - start,
      notes: results.length === 0 ? ["搜索无结果（网络受限或无匹配），可调整关键词重试"] : [`来源：Bing/DuckDuckGo`],
      results,
    };
  } catch (error) {
    return {
      ok: false, operatorId: "search", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── ExtractOp：关键信息抽取 ──────────────────────────────────────────────────

export const ExtractOpMeta: OperatorMeta = {
  id: "extract",
  name: "信息抽取",
  category: "research",
  description: "从网页正文抽取关键事实（数据/结论/时间），输出结构化要点列表",
  engine: "hybrid",
  params: [
    { name: "url", label: "网页 URL", type: "string", required: true, placeholder: "https://..." },
    { name: "focus", label: "关注要点", type: "string", required: false, placeholder: "例如：市场规模、增长率" },
  ],
};

const ExtractInput = z.object({
  url: z.string().url(),
  focus: z.string().max(200).optional(),
});

export async function runExtractOp(input: z.infer<typeof ExtractInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  try {
    const page = await fetchPage(input.url, 8000);
    const prompt = `从以下网页内容中抽取关键信息${input.focus ? `，重点关注：${input.focus}` : ""}。

标题：${page.title}
正文：
${page.text}

输出要求：
1. 每条要点一行，格式：- [要点内容]（含具体数据/时间则必须保留）
2. 最多 8 条，按重要性排序
3. 仅输出要点，不要前言后语`;

    const content = await chatCompletion(
      [{ role: "user", content: prompt }],
      { temperature: 0.1, maxTokens: 1024 },
    );
    const points = content.split("\n").map((l) => l.trim()).filter((l) => /^[-•]/.test(l)).map((l) => l.replace(/^[-•]\s*/, ""));
    return {
      ok: true,
      operatorId: "extract",
      columns: ["point"],
      rows: points.map((p) => ({ point: p })),
      rowCount: points.length,
      elapsedMs: Date.now() - start,
      notes: [`来源：${page.title} (${page.url})，正文 ${page.wordCount} 字`],
    };
  } catch (error) {
    return {
      ok: false, operatorId: "extract", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── SummarizeOp：内容摘要 ────────────────────────────────────────────────────

export const SummarizeOpMeta: OperatorMeta = {
  id: "summarize",
  name: "内容摘要",
  category: "research",
  description: "将多段研究素材压缩为结构化摘要（结论先行 + 要点列表）",
  engine: "llm",
  params: [
    { name: "text", label: "素材文本", type: "string", required: true, placeholder: "粘贴需要摘要的研究素材..." },
    { name: "style", label: "摘要风格", type: "enum", required: false, defaultValue: "structured", options: ["structured", "paragraph"] },
  ],
};

const SummarizeInput = z.object({
  text: z.string().min(10).max(20000),
  style: z.enum(["structured", "paragraph"]).default("structured"),
});

export async function runSummarizeOp(input: z.infer<typeof SummarizeInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  try {
    const prompt = `请${input.style === "structured" ? "用「一句话结论 + 3-5 条要点」的结构化格式" : "用一段连贯的段落"}摘要以下研究素材：

${input.text}`;

    const content = await chatCompletion(
      [{ role: "user", content: prompt }],
      { temperature: 0.2, maxTokens: 1024 },
    );
    return {
      ok: true,
      operatorId: "summarize",
      columns: ["summary"],
      rows: [{ summary: content }],
      rowCount: 1,
      elapsedMs: Date.now() - start,
      notes: [`风格：${input.style === "structured" ? "结构化" : "段落"}`],
    };
  } catch (error) {
    return {
      ok: false, operatorId: "summarize", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── CompareOp：多源对比 ──────────────────────────────────────────────────────

export const CompareOpMeta: OperatorMeta = {
  id: "compare",
  name: "多源对比",
  category: "research",
  description: "对比多个信息源的观点异同，识别共识与分歧，输出对比矩阵",
  engine: "llm",
  params: [
    { name: "sources", label: "信息源（每行一条）", type: "string", required: true, placeholder: "来源A：...\n来源B：...\n来源C：..." },
    { name: "topic", label: "对比主题", type: "string", required: true, placeholder: "例如：AI Agent 市场规模预测" },
  ],
};

const CompareInput = z.object({
  sources: z.string().min(20).max(20000),
  topic: z.string().min(2).max(200),
});

export async function runCompareOp(input: z.infer<typeof CompareInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  try {
    const prompt = `对比以下多个信息源关于「${input.topic}」的观点：

${input.sources}

输出要求：
1. 先用 2-3 句概括各源共识
2. 再列出分歧点，格式：- [分歧点]：源A认为...，源B认为...
3. 最后给出综合判断与置信度（高/中/低）`;

    const content = await chatCompletion(
      [{ role: "user", content: prompt }],
      { temperature: 0.2, maxTokens: 1536 },
    );
    return {
      ok: true,
      operatorId: "compare",
      columns: ["comparison"],
      rows: [{ comparison: content }],
      rowCount: 1,
      elapsedMs: Date.now() - start,
      notes: [],
    };
  } catch (error) {
    return {
      ok: false, operatorId: "compare", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── CitationOp：引用溯源 ─────────────────────────────────────────────────────

export const CitationOpMeta: OperatorMeta = {
  id: "citation",
  name: "引用溯源",
  category: "research",
  description: "将搜索结果整理为规范引用列表（编号/标题/URL/摘要），供报告脚注引用",
  engine: "sql",
  params: [
    { name: "query", label: "研究主题", type: "string", required: true },
  ],
};

const CitationInput = z.object({
  query: z.string().min(2).max(300),
});

export async function runCitationOp(input: z.infer<typeof CitationInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  try {
    const results = await webSearch(input.query, 8);
    const rows = results.map((r, i) => ({
      no: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet.slice(0, 120),
      citation: `[${i + 1}] ${r.title}. ${new URL(r.url).hostname}.`,
    }));
    return {
      ok: rows.length > 0,
      operatorId: "citation",
      columns: ["no", "title", "url", "snippet", "citation"],
      rows,
      rowCount: rows.length,
      elapsedMs: Date.now() - start,
      notes: ["citation 列可直接粘贴到报告脚注"],
    };
  } catch (error) {
    return {
      ok: false, operatorId: "citation", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── WriteOp：报告段落生成 ────────────────────────────────────────────────────

export const WriteOpMeta: OperatorMeta = {
  id: "write",
  name: "报告写作",
  category: "research",
  description: "基于研究素材生成指定章节的报告段落（Markdown），支持指定受众与语气",
  engine: "llm",
  params: [
    { name: "section", label: "章节主题", type: "string", required: true, placeholder: "例如：市场规模与增长驱动因素" },
    { name: "material", label: "研究素材", type: "string", required: true, placeholder: "粘贴数据结论与研究发现..." },
    { name: "audience", label: "目标受众", type: "enum", required: false, defaultValue: "管理层", options: ["管理层", "分析师", "业务团队"] },
  ],
};

const WriteInput = z.object({
  section: z.string().min(2).max(200),
  material: z.string().min(20).max(20000),
  audience: z.enum(["管理层", "分析师", "业务团队"]).default("管理层"),
});

export async function runWriteOp(input: z.infer<typeof WriteInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  try {
    const prompt = `你是资深行业研究分析师。请基于以下研究素材，为报告撰写「${input.section}」章节。

目标受众：${input.audience}（${input.audience === "管理层" ? "重结论与决策建议，弱化技术细节" : input.audience === "分析师" ? "保留方法论与数据推导细节" : "重行动项与业务影响"}）

研究素材：
${input.material}

输出要求：
1. Markdown 格式，以 ## 二级标题开头
2. 300-500 字
3. 数据必须来自素材，不得编造；无数据支撑的判断标注（待验证）
4. 结尾用引用块列出本节引用的关键事实来源（如 [1][2]）`;

    const content = await chatCompletion(
      [{ role: "user", content: prompt }],
      { temperature: 0.3, maxTokens: 2048 },
    );
    return {
      ok: true,
      operatorId: "write",
      columns: ["markdown"],
      rows: [{ markdown: content }],
      rowCount: 1,
      elapsedMs: Date.now() - start,
      notes: [],
    };
  } catch (error) {
    return {
      ok: false, operatorId: "write", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
