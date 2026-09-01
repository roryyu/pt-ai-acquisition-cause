/**
 * 研究知识图谱类型（doc/深度研究知识图谱融合设计-Understand-Anything.md 3.2）
 *
 * 移植 Understand-Anything 的「图谱即 JSON」理念：深度研究报告经 LLM 抽取为
 * 实体/主题/关系图谱，落盘为单一 JSON 文件，增量合并、可重建、可共享。
 *
 * 三类节点对应 UA 的分层图：
 * - entity（渠道/市场/竞品/厂商/政策/指标）≈ UA 的文件/函数节点
 * - topic（研究主题）≈ UA 的架构层
 * - report（研究本身）≈ UA 的导览入口
 */

export type GraphNodeType = "entity" | "topic" | "report";

export interface GraphNode {
  /** node_xxx（实体/主题）或承载报告的 questionId（report 节点） */
  id: string;
  /** 展示名（实体名 / 主题名 / 研究目标摘要） */
  label: string;
  type: GraphNodeType;
  /** 一句话语义摘要（LLM 产出） */
  summary: string;
  /** 出现于哪些研究（questionId 列表） */
  reportIds: string[];
  updatedAt: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** 关系语义：如「竞争于」「投放于」「受…影响」「研究涉及」 */
  relation: string;
  /** 支撑该边的研究（溯源，UA referential integrity 思想） */
  reportIds: string[];
}

export interface GraphReportRef {
  /** 承载报告的 Question id */
  questionId: string;
  /** 研究问题 */
  question: string;
  /** Planner 研究目标 */
  objective: string;
  /** 报告摘要（抽取时产出） */
  summary: string;
  createdAt: string;
}

export interface KnowledgeGraph {
  version: 1;
  updatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 以 questionId 索引的历史研究 */
  reports: GraphReportRef[];
}

/** 图谱补丁：单次研究抽取产出（extractor.ts → mergeGraph） */
export interface GraphPatch {
  summary: string;
  entities: Array<{ label: string; summary: string }>;
  topics: Array<{ label: string; summary: string }>;
  relations: Array<{ source: string; target: string; relation: string }>;
}

/** 空图（图谱不存在/损坏时的兜底） */
export function emptyGraph(): KnowledgeGraph {
  return { version: 1, updatedAt: new Date(0).toISOString(), nodes: [], edges: [], reports: [] };
}

/** 实体/主题去重键：归一化名称（去空格、全角转半角、英文小写） */
export function normalizeNodeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 从模型输出中提取 JSON（容忍 markdown 代码块包裹与前后杂讯） */
export function extractJson(raw: string): Record<string, unknown> | null {
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

/** 解析并校验图谱补丁（纯函数，便于测试）；不合法返回 null */
export function parseGraphPatch(raw: string): GraphPatch | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 200) : "";
  const entities = Array.isArray(parsed.entities)
    ? parsed.entities
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
        .map((e) => ({ label: String(e.label ?? "").trim(), summary: String(e.summary ?? "").trim() }))
        .filter((e) => e.label)
        .slice(0, 8)
    : [];
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
        .map((t) => ({ label: String(t.label ?? "").trim(), summary: String(t.summary ?? "").trim() }))
        .filter((t) => t.label)
        .slice(0, 3)
    : [];
  const relations = Array.isArray(parsed.relations)
    ? parsed.relations
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
        .map((r) => ({
          source: String(r.source ?? "").trim(),
          target: String(r.target ?? "").trim(),
          relation: String(r.relation ?? "").trim(),
        }))
        .filter((r) => r.source && r.target && r.relation)
        .slice(0, 8)
    : [];

  // 无任何可入图内容时视为抽取失败
  if (!summary && entities.length === 0 && topics.length === 0) return null;
  return { summary, entities, topics, relations };
}
