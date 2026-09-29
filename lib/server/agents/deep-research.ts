import { chatCompletion, chatCompletionStream } from "@/lib/server/model-gateway";
import { runOperator } from "@/lib/server/operators/registry";
import { extractGraphPatch } from "@/lib/server/research-graph/extractor";
import { loadGraph, mergeGraph, saveGraph, type MergeStats } from "@/lib/server/research-graph/store";
import { verifyCitationIntegrity, type CitationReview } from "@/lib/server/research-graph/review";
import type { AgentEvent } from "./events";
import { PLANNER_PROMPT, EXTRACTOR_PROMPT, REPORT_PROMPT } from "./prompts";

/**
 * 深度研究多 Agent 工作流（design.md 4.3.2 研究工作流状态机）
 *
 *   Planner（研究规划：拆解 3-5 个子问题 + 检索关键词）
 *     → Executor（逐子问题：SearchOp 多轮检索 → ExtractOp 深读抽取 → 证据整合）
 *     → Analyzing（CompareOp 多源交叉比对：共识/分歧/置信度）
 *     → Synthesizer（汇总全部证据，流式生成结构化研究报告）
 *
 * 状态机映射 ResearchState：
 *   queued → planning → collecting → analyzing → writing → completed | failed
 *
 * Understand-Anything 融合（doc/深度研究知识图谱融合设计-Understand-Anything.md）：
 * - 图谱引导规划：发起前检索研究知识图谱，命中历史研究/实体注入 Planner 与报告生成；
 * - 并行收集：子问题经并发受限并行池收集证据（UA file-analyzer 并行 worker 思想）；
 * - 产出校验：报告完成后引用完整性校验（graph-reviewer 思想，软校验）；
 * - 图谱沉淀：报告经 LLM 抽取实体/主题/关系，增量合并入知识图谱（失败静默降级）。
 *
 * 算子优先（design.md 5.2.2 研究算子）：检索/抽取/对比动作一律经算子注册表
 * runOperator 调度（search / extract / compare）；跨材料证据整合与流式报告
 * 由 Agent 提示词承担（EXTRACTOR_PROMPT / REPORT_PROMPT）——
 * WriteOp 为定长段落生成器无法流式成稿，CitationOp 会重复检索，故不接入。
 *
 * 与 supervisor.ts 的问答级 research 路径互补：本模块面向"深度研究任务"
 * （用户显式发起、产出正式报告、每个子问题作为子任务可追踪）。
 */

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export interface SubQuestionPlan {
  id: string;
  question: string;
  rationale: string;
  keywords: string[];
}

export interface SubQuestionResult {
  id: string;
  question: string;
  rationale: string;
  findings: string[];
  /** 本轮使用的原文摘录与未深读摘要；可选以兼容历史研究记录 */
  evidence?: EvidenceMaterial[];
  /** 本子问题引用的编号列表 */
  citationNos: number[];
  searchedQueries: string[];
  elapsedMs: number;
}

export interface CitationEntry {
  no: number;
  title: string;
  url: string;
}

export interface DeepResearchResult {
  objective: string;
  subQuestions: SubQuestionResult[];
  report: string;
  citations: CitationEntry[];
  elapsedMs: number;
  /** 引用完整性校验结论（软校验，不阻断完成） */
  review?: CitationReview;
  /** 本次研究对知识图谱的增量统计（图谱更新失败时为 null） */
  graphStats?: MergeStats | null;
}

export interface DeepResearchOptions {
  questionId: string;
  question: string;
  sink: (event: AgentEvent) => void;
  /** 状态机回调：由 API 路由持久化到 ResearchTask/Question */
  onStateChange?: (state: "planning" | "collecting" | "analyzing" | "writing" | "completed" | "failed") => void | Promise<void>;
  /** 子任务回调：每个子问题完成时持久化 */
  onSubTask?: (result: SubQuestionResult) => void | Promise<void>;
  /** 抓取深度：standard 每子问题深读 2 页，deep 深读 3 页 */
  depth?: "standard" | "deep";
  /** 来源任务问答背景（任务问答「进行深入研究」时注入，见 prompts.ts researchSourceContextBlock） */
  sourceContext?: string;
  /** 研究知识图谱背景（发起前图谱检索命中，见 prompts.ts graphContextBlock） */
  graphContext?: string;
}

// ─── 引用登记（全局去重分配编号）──────────────────────────────────────────────

class CitationRegistry {
  private entries: CitationEntry[] = [];
  private byUrl = new Map<string, number>();

  register(title: string, url: string): number {
    const existing = this.byUrl.get(url);
    if (existing !== undefined) return existing;
    const no = this.entries.length + 1;
    this.entries.push({ no, title, url });
    this.byUrl.set(url, no);
    return no;
  }

  all(): CitationEntry[] {
    return [...this.entries];
  }
}

// ─── Planner：研究规划 ─────────────────────────────────────────────────────────

interface RawPlan {
  objective?: unknown;
  subQuestions?: unknown;
}

async function planResearch(
  question: string,
  sourceContext?: string,
  graphContext?: string,
): Promise<{ objective: string; subQuestions: SubQuestionPlan[] }> {
  // 背景前置注入（任务问答背景 + 图谱背景可叠加），子问题围绕用户研究方向在背景之上向外延展
  const prefixes = [sourceContext, graphContext].filter((p) => p && p.trim()).join("\n\n");
  const raw = await chatCompletion(
    [
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: prefixes ? `${prefixes}\n\n研究问题：${question}` : question },
    ],
    { temperature: 0.2, maxTokens: 2048 },
  );
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Planner 输出无法解析为 JSON");
  }
  const obj = parsed as RawPlan;
  const objective = typeof obj.objective === "string" && obj.objective.trim() ? obj.objective.trim() : question;
  const rawSubs = Array.isArray(obj.subQuestions) ? obj.subQuestions : [];
  const subQuestions: SubQuestionPlan[] = [];
  for (const item of rawSubs.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const sq = item as Record<string, unknown>;
    const q = typeof sq.question === "string" ? sq.question.trim() : "";
    if (!q) continue;
    subQuestions.push({
      id: `sub_${subQuestions.length + 1}`,
      question: q,
      rationale: typeof sq.rationale === "string" ? sq.rationale.trim() : "",
      keywords: Array.isArray(sq.keywords)
        ? sq.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 3)
        : [],
    });
  }
  if (subQuestions.length === 0) {
    // 兜底：单子问题即原问题
    subQuestions.push({ id: "sub_1", question, rationale: "Planner 拆解失败，直接研究原问题", keywords: [] });
  }
  return { objective, subQuestions };
}

// ─── Executor：逐子问题证据收集（研究算子驱动）────────────────────────────────

/** 检索命中（SearchOp rows 归一化） */
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

type EvidenceMaterial = {
  no: number;
  title: string;
  url: string;
  text: string;
  kind: "search_snippet" | "page_excerpt";
};

/** 页内锚点不代表独立来源，保留可能影响正文的查询参数。 */
function normalizeEvidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function formatEvidenceMaterial(material: EvidenceMaterial): string {
  const label = material.kind === "page_excerpt" ? "正文摘录" : "搜索摘要（未核对正文）";
  return `[${material.no}] ${material.title}\n来源：${material.url}\n${label}：\n${material.text}`;
}

/** SearchOp 结果行归一化为检索命中 */
function toSearchHits(rows: Record<string, unknown>[]): SearchHit[] {
  return rows
    .map((r) => ({
      title: String(r.title ?? ""),
      url: normalizeEvidenceUrl(String(r.url ?? "")),
      snippet: String(r.snippet ?? ""),
    }))
    .filter((r) => r.url);
}

async function collectEvidenceForSubQuestion(
  plan: SubQuestionPlan,
  registry: CitationRegistry,
  sink: (event: AgentEvent) => void,
  stepPrefix: string,
  deepReadCount: number,
): Promise<SubQuestionResult> {
  const t0 = Date.now();
  const searchedQueries: string[] = [];
  const materials: EvidenceMaterial[] = [];
  const seenUrls = new Set<string>();

  // 1) 检索：子问题本身 + Planner 关键词（最多 3 轮，经 SearchOp 算子）
  const queries = [plan.question, ...plan.keywords].slice(0, 3);
  let searchResults: SearchHit[] = [];
  for (const query of queries) {
    const stepId = `${stepPrefix}_search_${searchedQueries.length + 1}`;
    sink({ type: "tool_call", stepId, tool: "search", input: { query, maxResults: 6 } });
    const tSearch = Date.now();
    searchedQueries.push(query);
    const opResult = await runOperator("search", { query, maxResults: 6 });
    const results = opResult.ok ? toSearchHits(opResult.rows) : [];
    searchResults = searchResults.concat(results);
    sink({
      type: "tool_result", stepId, tool: "search",
      summary: opResult.ok
        ? `检索到 ${results.length} 条结果`
        : `检索失败：${opResult.error ?? "无结果"}`,
      elapsedMs: Date.now() - tSearch,
    });
    if (results.length >= 4 && queries.length > 1 && searchedQueries.length >= 2) break; // 证据足够则省额
  }

  // 2) 摘要先入证据池（全部检索结果）
  for (const r of searchResults) {
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    const no = registry.register(r.title, r.url);
    materials.push({ no, title: r.title, url: r.url, text: r.snippet.slice(0, 1200), kind: "search_snippet" });
  }

  // 3) 深读：排名靠前的结果经 ExtractOp 算子抽取关键要点（聚焦子问题）
  // 去重后按成功页数计额；失败可换下一页，但尝试次数最多为目标页数的两倍。
  const deepTargets = materials.slice(0, deepReadCount * 2);
  let deepReadSucceeded = 0;
  for (let i = 0; i < deepTargets.length && deepReadSucceeded < deepReadCount; i++) {
    const target = deepTargets[i];
    if (!target) continue;
    const stepId = `${stepPrefix}_extract_${i + 1}`;
    sink({ type: "tool_call", stepId, tool: "extract", input: { url: target.url, focus: plan.question } });
    const tFetch = Date.now();
    const opResult = await runOperator("extract", { url: target.url, focus: plan.question });
    const quotes = opResult.ok
      ? opResult.rows.map((r) => typeof r.quote === "string" ? r.quote.trim() : "").filter(Boolean)
      : [];
    if (quotes.length > 0) {
      deepReadSucceeded += 1;
      const no = registry.register(target.title, target.url);
      // 深读要点替换同 URL 的摘要材料
      const idx = materials.findIndex((m) => m.url === target.url);
      const entry: EvidenceMaterial = {
        no,
        title: target.title,
        url: target.url,
        text: quotes.join("\n\n"),
        kind: "page_excerpt",
      };
      if (idx >= 0) materials[idx] = entry;
      else materials.push(entry);
      sink({
        type: "tool_result", stepId, tool: "extract",
        summary: `「${target.title.slice(0, 40)}」保留 ${quotes.length} 条正文摘录`,
        elapsedMs: Date.now() - tFetch,
      });
    } else {
      sink({
        type: "tool_result", stepId, tool: "extract",
        summary: `抽取失败：${opResult.error ?? "无可用要点"}`,
        elapsedMs: Date.now() - tFetch,
      });
    }
  }

  // 4) 证据抽取：LLM 基于材料生成结构化发现
  const materialBlock = materials.map(formatEvidenceMaterial).join("\n\n");
  let findings: string[] = [];
  let citationNos: number[] = [];
  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: EXTRACTOR_PROMPT },
        { role: "user", content: `子问题：${plan.question}\n\n检索材料：\n${materialBlock}` },
      ],
      { temperature: 0.2, maxTokens: 2048 },
    );
    const parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.findings)) {
      findings = parsed.findings.filter((f): f is string => typeof f === "string" && f.trim().length > 0);
    } else if (raw.trim()) {
      // 非 JSON 输出兜底：按行拆
      findings = raw.trim().split(/\n+/).filter((l) => l.trim().length > 10).slice(0, 4);
    }
    citationNos = extractCitationNos(findings.join(" "));
  } catch (error) {
    findings = [`证据抽取失败：${error instanceof Error ? error.message : String(error)}`];
  }

  if (findings.length === 0) {
    findings = [`未检索到能直接回答「${plan.question}」的高质量证据，建议调整检索关键词`];
  }

  return {
    id: plan.id,
    question: plan.question,
    rationale: plan.rationale,
    findings,
    evidence: materials,
    citationNos: [...new Set(citationNos)],
    searchedQueries,
    elapsedMs: Date.now() - t0,
  };
}

/** 从文本中提取 [n] 引用编号 */
function extractCitationNos(text: string): number[] {
  const matches = text.matchAll(/\[(\d+)\]/g);
  const nos: number[] = [];
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) nos.push(n);
  }
  return nos;
}

// ─── Analyzing：多源交叉比对（CompareOp）────────────────────────────────────

/**
 * 汇总各子问题发现交给 CompareOp 比对共识/分歧（证据过少时跳过）。
 * 失败静默降级为空串，不阻断报告生成。
 */
async function compareResearchEvidence(
  objective: string,
  subResults: SubQuestionResult[],
  sink: (event: AgentEvent) => void,
): Promise<string> {
  // 仅纳入有真实发现的子问题（排除无证据兜底文案）
  const usable = subResults.filter(
    (r) => r.findings.length > 0 && !r.findings.every((f) => f.startsWith("未检索到能直接回答")),
  );
  const sources = usable
    .map((r) => `【${r.question}】\n${r.findings.slice(0, 3).map((f) => `- ${f}`).join("\n")}`)
    .join("\n\n")
    .slice(0, 8000);
  // CompareOp 输入要求 sources ≥ 20 字，且至少两个子问题有发现才有对比价值
  if (sources.length < 40 || usable.length < 2) return "";

  const stepId = "dr_compare";
  sink({ type: "step", stepId, agent: "researcher", label: "多源交叉比对（CompareOp）", status: "running" });
  sink({ type: "tool_call", stepId, tool: "compare", input: { topic: objective, sourceLength: sources.length } });
  const t0 = Date.now();
  const opResult = await runOperator("compare", { sources, topic: objective });
  if (!opResult.ok || opResult.rowCount === 0) {
    sink({
      type: "tool_result", stepId, tool: "compare",
      summary: `比对失败：${opResult.error ?? "无输出"}`, elapsedMs: Date.now() - t0,
    });
    sink({ type: "step", stepId, agent: "researcher", label: "多源比对跳过（算子失败，静默降级）", status: "done" });
    return "";
  }
  const comparison = String(opResult.rows[0]?.comparison ?? "").trim();
  sink({
    type: "tool_result", stepId, tool: "compare",
    summary: `比对完成（${comparison.length} 字）`, elapsedMs: Date.now() - t0,
  });
  sink({ type: "step", stepId, agent: "researcher", label: "多源交叉比对完成", status: "done" });
  return comparison;
}

// ─── Synthesizer：研究报告生成（REPORT_PROMPT 见 prompts.ts）─────────────────────────────

// ─── 并发受限并行池（UA file-analyzer 并行 worker 思想，零依赖内联实现）──────

/** 按原顺序回填结果的受限并行执行器 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ─── 知识图谱增量更新（完成后沉淀，失败静默降级不阻断）────────────────────────

/**
 * 报告 → 图谱补丁 → 增量合并落盘（设计文档 4.1/4.2）。
 * 任一步失败仅透出降级文案事件，返回 null，不影响研究完成。
 */
async function updateResearchGraph(
  questionId: string,
  question: string,
  objective: string,
  subResults: SubQuestionResult[],
  report: string,
  sink: (event: AgentEvent) => void,
): Promise<MergeStats | null> {
  const stepId = "dr_graph_update";
  sink({ type: "tool_call", stepId, tool: "graph_update", input: { questionId } });
  const t0 = Date.now();
  try {
    const patch = await extractGraphPatch(question, objective, subResults, report);
    if (!patch) {
      sink({ type: "tool_result", stepId, tool: "graph_update", summary: "图谱抽取无可入图内容，本次跳过沉淀", elapsedMs: Date.now() - t0 });
      return null;
    }
    const base = await loadGraph();
    const { graph, stats } = mergeGraph(base, patch, {
      questionId,
      question,
      objective,
      summary: patch.summary,
      createdAt: new Date().toISOString(),
    });
    await saveGraph(graph);
    sink({
      type: "tool_result", stepId, tool: "graph_update",
      summary: `研究知识图谱已更新：新增 ${stats.addedNodes} 节点 / ${stats.addedEdges} 边，更新 ${stats.updatedNodes} 节点`,
      elapsedMs: Date.now() - t0,
    });
    return stats;
  } catch (error) {
    sink({
      type: "tool_result", stepId, tool: "graph_update",
      summary: `图谱更新失败（静默降级）：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs: Date.now() - t0,
    });
    return null;
  }
}

// ─── 对外入口 ─────────────────────────────────────────────────────────────────

/**
 * 运行深度研究工作流：Planner → Executor（逐子问题） → Synthesizer
 * 全程事件经 sink 推送（plan / phase / step / tool_call / tool_result / citations / chunk / done）
 */
export async function runDeepResearch(options: DeepResearchOptions): Promise<DeepResearchResult> {
  const { question, sink } = options;
  const deepReadCount = options.depth === "deep" ? 3 : 2;
  const t0 = Date.now();
  const registry = new CitationRegistry();

  try {
    // ── Planner（图谱背景 + 任务问答背景前置注入）──
    await options.onStateChange?.("planning");
    sink({ type: "phase", phase: "research", label: "研究规划（Planner 拆解子问题）" });
    const planStepId = `dr_plan`;
    sink({ type: "step", stepId: planStepId, agent: "supervisor", label: "拆解研究问题", status: "running" });

    const { objective, subQuestions } = await planResearch(question, options.sourceContext, options.graphContext);

    sink({
      type: "step", stepId: planStepId, agent: "supervisor",
      label: `研究计划就绪（${subQuestions.length} 个子问题）`, status: "done",
      detail: subQuestions.map((s) => s.question).join("；"),
    });
    sink({
      type: "plan",
      objective,
      subQuestions: subQuestions.map((s) => ({ id: s.id, question: s.question, rationale: s.rationale })),
    });

    // ── Executor（子问题并发 2 受限并行收集，事件按子问题 stepId 区分）──
    await options.onStateChange?.("collecting");
    sink({ type: "phase", phase: "research", label: "证据收集（Executor 并行检索与深读）" });

    const subResults = await runWithConcurrency(subQuestions, 2, async (plan, i) => {
      const stepId = `dr_sub_${i + 1}`;
      sink({
        type: "step", stepId, agent: "researcher",
        label: `子问题 ${i + 1}/${subQuestions.length}：${plan.question.slice(0, 50)}`,
        status: "running",
        detail: plan.rationale || undefined,
      });
      const result = await collectEvidenceForSubQuestion(plan, registry, sink, stepId, deepReadCount);
      await options.onSubTask?.(result);
      sink({
        type: "step", stepId, agent: "researcher",
        label: `子问题 ${i + 1} 完成（${result.findings.length} 条发现）`, status: "done",
        detail: `${(result.elapsedMs / 1000).toFixed(1)}s · ${result.searchedQueries.length} 次检索`,
      });
      return result;
    });

    const citations = registry.all();
    if (citations.length > 0) {
      sink({ type: "citations", citations });
    }

    // ── Analyzing：多源交叉比对（CompareOp 算子）──
    await options.onStateChange?.("analyzing");
    sink({ type: "phase", phase: "analyzing", label: "多源比对（CompareOp 比对共识与分歧）" });
    const comparison = await compareResearchEvidence(objective, subResults, sink);

    // ── Synthesizer ──
    await options.onStateChange?.("writing");
    sink({ type: "phase", phase: "synthesis", label: "报告撰写（Synthesizer 汇总证据）" });
    const writeStepId = `dr_write`;
    sink({ type: "step", stepId: writeStepId, agent: "synthesizer", label: "撰写研究报告", status: "running" });

    const evidenceBlock = subResults
      .map(
        (r, i) =>
          `### 子问题 ${i + 1}：${r.question}\n${r.findings.map((f) => `- ${f}`).join("\n")}`,
      )
      .join("\n\n");
    // 原文绕过发现摘要直达写作；未深读来源仅附已引用的至多 4 条短摘要，控制上下文成本。
    const sourceEvidenceBlock = subResults.map((r) => {
      const evidence = r.evidence ?? [];
      const excerpts = evidence.filter((m) => m.kind === "page_excerpt");
      const snippets = evidence
        .filter((m) => m.kind === "search_snippet" && r.citationNos.includes(m.no))
        .slice(0, 4)
        .map((m) => ({ ...m, text: m.text.slice(0, 600) }));
      const block = [...excerpts, ...snippets].map(formatEvidenceMaterial).join("\n\n");
      return `### ${r.question}\n${block || "未取得可用原文证据；不能据此给出确定结论。"}`;
    }).join("\n\n");
    const citationBlock = citations.map((c) => `[${c.no}] ${c.title} — ${c.url}`).join("\n");
    // 来源任务问答背景：报告需呼应背景结论并给出针对性建议（无背景时不注入）
    const sourceBlock = options.sourceContext ? `${options.sourceContext}\n\n` : "";
    // 研究知识图谱背景：报告需说明相对历史研究的增量（无命中时不注入）
    const graphBlock = options.graphContext ? `${options.graphContext}\n\n` : "";
    // CompareOp 多源比对结论：供综合分析吸收共识/分歧判断（比对跳过时不注入）
    const compareBlock = comparison ? `## 多源比对结论（CompareOp 算子）\n${comparison}\n\n` : "";

    let report = "";
    for await (const chunk of chatCompletionStream(
      [
        { role: "system", content: REPORT_PROMPT },
        {
          role: "user",
          content: `${sourceBlock}${graphBlock}研究问题：${question}\n研究目标：${objective}\n\n## 原始证据\n${sourceEvidenceBlock}\n\n${compareBlock}## 各子问题研究发现\n${evidenceBlock}\n\n## 引用来源\n${citationBlock}`,
        },
      ],
      { temperature: 0.3, maxTokens: 8192 },
    )) {
      report += chunk;
      sink({ type: "chunk", content: chunk });
    }

    sink({ type: "step", stepId: writeStepId, agent: "synthesizer", label: "报告撰写完成", status: "done" });

    // ── Review：引用完整性校验（graph-reviewer 思想，软校验不阻断）──
    const reviewStepId = "dr_review";
    sink({ type: "step", stepId: reviewStepId, agent: "critic", label: "引用完整性校验", status: "running" });
    const review = verifyCitationIntegrity(report, citations);
    sink({
      type: "step", stepId: reviewStepId, agent: "critic",
      label: review.passed ? "引用完整性校验通过" : `引用校验发现 ${review.issues.length} 项问题（不阻断）`,
      status: "done",
      detail: review.passed ? undefined : review.issues.join("；"),
    });

    // ── 图谱沉淀：报告抽取实体/主题/关系增量合并入研究知识图谱 ──
    const graphStats = await updateResearchGraph(options.questionId, question, objective, subResults, report, sink);

    await options.onStateChange?.("completed");

    return { objective, subQuestions: subResults, report, citations, elapsedMs: Date.now() - t0, review, graphStats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sink({ type: "error", message: `深度研究失败：${message}` });
    await options.onStateChange?.("failed");
    throw error;
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 从模型输出中提取 JSON（容忍 markdown 代码块包裹） */
function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
      } catch {
        // 继续
      }
    }
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}
