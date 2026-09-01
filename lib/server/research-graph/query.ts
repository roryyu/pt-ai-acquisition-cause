import type { GraphReportRef, KnowledgeGraph, GraphNode } from "./types";

/**
 * 图谱检索（设计文档 4.3）：以研究问题召回相关节点与历史研究
 *
 * 词元重叠打分（零依赖，不引向量库）：英文按非字母数字切分，
 * 中文按 2-3 字滑窗 bigram；节点 label/summary 与问题词元重叠越多分越高，
 * 近 90 天被研究引用的节点新鲜度加权。纯函数可测。
 */

export interface GraphQueryHit {
  nodes: GraphNode[];
  reports: GraphReportRef[];
}

/** 新鲜度加权窗口 */
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** 问题/节点文本 → 词元集合（英文单词 + 中文 2 字滑窗） */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lowered = text.toLowerCase();
  for (const m of lowered.matchAll(/[a-z0-9]{2,}/g)) tokens.add(m[0]);
  const cjk = lowered.replace(/[^\u4e00-\u9fff]/g, "|");
  for (const seg of cjk.split("|")) {
    if (seg.length < 2) continue;
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.add(seg.slice(i, i + 2));
      if (i < seg.length - 2) tokens.add(seg.slice(i, i + 3));
    }
  }
  return tokens;
}

/**
 * 检索图谱：返回 topK 相关节点（实体/主题优先）与关联历史研究（≤3 条）。
 * 空图/无命中返回空结果（上层静默跳过注入）。
 */
export function queryGraph(graph: KnowledgeGraph, question: string, topK = 6): GraphQueryHit {
  const questionTokens = tokenize(question);
  if (questionTokens.size === 0 || graph.nodes.length === 0) return { nodes: [], reports: [] };

  const now = Date.now();
  const scored = graph.nodes
    .filter((n) => n.type !== "report")
    .map((node) => {
      const nodeTokens = tokenize(`${node.label} ${node.summary}`);
      let overlap = 0;
      for (const t of questionTokens) if (nodeTokens.has(t)) overlap += 1;
      if (overlap === 0) return null;
      // label 直接命中加权更高（实体名匹配比摘要匹配更可信）
      let labelHit = 0;
      for (const t of tokenize(node.label)) if (questionTokens.has(t)) labelHit += 2;
      const freshness = node.reportIds.length > 0 && now - Date.parse(node.updatedAt) < RECENT_WINDOW_MS ? 0.5 : 0;
      return { node, score: overlap + labelHit + freshness };
    })
    .filter((s): s is { node: GraphNode; score: number } => s !== null && s.score > 1)
    .sort((a, b) => b.score - a.score);

  const nodes = scored.slice(0, topK).map((s) => s.node);

  // 关联历史研究：命中节点引用过的研究，按图谱内时间倒序去重
  const hitReportIds = new Set(nodes.flatMap((n) => n.reportIds));
  const reports = graph.reports
    .filter((r) => hitReportIds.has(r.questionId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 3);

  return { nodes, reports };
}
