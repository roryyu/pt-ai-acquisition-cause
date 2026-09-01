import { promises as fs } from "node:fs";
import path from "node:path";
import { newId } from "@/lib/server/ids";
import {
  type GraphPatch,
  type GraphReportRef,
  type KnowledgeGraph,
  emptyGraph,
  normalizeNodeLabel,
} from "./types";

/**
 * 研究知识图谱存取（设计文档 4.2）
 *
 * 图谱即 JSON（UA 理念）：落盘于 data/research-graph/knowledge-graph.json，
 * 原子写（临时文件 + rename）；RESEARCH_GRAPH_PATH 环境变量可覆盖路径（测试用）。
 * 图谱是派生物——损坏/丢失时可经 POST /api/v1/research/graph/rebuild 全量重建。
 */

/** 节点规模上限：超限丢弃最旧且近期未被引用的实体（设计文档 6 风险表） */
const MAX_NODES = 500;
/** 近期引用窗口：90 天内被研究引用过的实体优先保留 */
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export function graphFilePath(): string {
  if (process.env.RESEARCH_GRAPH_PATH) return process.env.RESEARCH_GRAPH_PATH;
  return path.join(process.cwd(), "data", "research-graph", "knowledge-graph.json");
}

/** 加载图谱：不存在/解析失败均返回空图（静默降级，不阻断研究主流程） */
export async function loadGraph(): Promise<KnowledgeGraph> {
  try {
    const raw = await fs.readFile(graphFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as KnowledgeGraph;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return emptyGraph();
    return { ...emptyGraph(), ...parsed, version: 1 };
  } catch {
    return emptyGraph();
  }
}

/** 原子保存图谱：写临时文件后 rename，避免半写状态 */
export async function saveGraph(graph: KnowledgeGraph): Promise<void> {
  const filePath = graphFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(graph, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/** 合并统计（透出到 answer.graphStats 与事件） */
export interface MergeStats {
  addedNodes: number;
  addedEdges: number;
  updatedNodes: number;
}

/**
 * 增量合并图谱补丁（纯函数，不修改传入对象）：
 * 1. reports 按 questionId upsert；
 * 2. 实体/主题节点按归一化 label 匹配——命中并集 reportIds + 更新摘要，未命中新建；
 * 3. report 节点与其主题自动补「研究涉及」边；关系边按三元组去重；
 * 4. 节点超限时裁剪最旧且非近期引用的实体节点。
 */
export function mergeGraph(
  base: KnowledgeGraph,
  patch: GraphPatch,
  reportRef: GraphReportRef,
): { graph: KnowledgeGraph; stats: MergeStats } {
  const now = new Date().toISOString();
  const nodes = base.nodes.map((n) => ({ ...n, reportIds: [...n.reportIds] }));
  const edges = base.edges.map((e) => ({ ...e, reportIds: [...e.reportIds] }));
  const reports = base.reports.filter((r) => r.questionId !== reportRef.questionId);
  reports.push({ ...reportRef, summary: patch.summary || reportRef.summary });

  const stats: MergeStats = { addedNodes: 0, addedEdges: 0, updatedNodes: 0 };
  const labelToNode = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (n.type !== "report") labelToNode.set(normalizeNodeLabel(n.label), i);
  });

  /** 获取或新建实体/主题节点，返回节点索引 */
  const upsertNode = (label: string, type: "entity" | "topic", summary: string): number => {
    const key = normalizeNodeLabel(label);
    const existingIdx = labelToNode.get(key);
    if (existingIdx !== undefined) {
      const node = nodes[existingIdx]!;
      if (!node.reportIds.includes(reportRef.questionId)) node.reportIds.push(reportRef.questionId);
      if (summary.trim()) node.summary = summary.trim();
      node.updatedAt = now;
      stats.updatedNodes += 1;
      return existingIdx;
    }
    nodes.push({
      id: newId("node"),
      label: label.trim(),
      type,
      summary: summary.trim(),
      reportIds: [reportRef.questionId],
      updatedAt: now,
    });
    const idx = nodes.length - 1;
    labelToNode.set(key, idx);
    stats.addedNodes += 1;
    return idx;
  };

  /** 边按 (source, target, relation) 三元组去重，reportIds 并集 */
  const upsertEdge = (sourceId: string, targetId: string, relation: string) => {
    if (sourceId === targetId) return;
    const existing = edges.find((e) => e.source === sourceId && e.target === targetId && e.relation === relation);
    if (existing) {
      if (!existing.reportIds.includes(reportRef.questionId)) existing.reportIds.push(reportRef.questionId);
      return;
    }
    edges.push({ source: sourceId, target: targetId, relation, reportIds: [reportRef.questionId] });
    stats.addedEdges += 1;
  };

  // 实体与主题节点（名称去重、摘要以最新为准）
  for (const e of patch.entities.slice(0, 8)) {
    if (!e.label?.trim()) continue;
    upsertNode(e.label, "entity", e.summary ?? "");
  }
  const topicNodeIds: number[] = [];
  for (const t of patch.topics.slice(0, 3)) {
    if (!t.label?.trim()) continue;
    topicNodeIds.push(upsertNode(t.label, "topic", t.summary ?? ""));
  }

  // report 节点 + 「研究涉及」边（report → topic）
  const reportNodeId = reportRef.questionId;
  nodes.push({
    id: reportNodeId,
    label: reportRef.objective || reportRef.question,
    type: "report",
    summary: patch.summary,
    reportIds: [reportRef.questionId],
    updatedAt: now,
  });
  stats.addedNodes += 1;
  for (const topicIdx of topicNodeIds) {
    upsertEdge(reportNodeId, nodes[topicIdx]!.id, "研究涉及");
  }

  // 抽取的关系边：端点按名称解析为节点，解析不到的端点自动补实体节点
  for (const rel of patch.relations.slice(0, 8)) {
    const source = rel.source?.trim();
    const target = rel.target?.trim();
    const relation = rel.relation?.trim();
    if (!source || !target || !relation) continue;
    const sourceIdx = upsertNode(source, "entity", "");
    const targetIdx = upsertNode(target, "entity", "");
    upsertEdge(nodes[sourceIdx]!.id, nodes[targetIdx]!.id, relation);
  }

  return { graph: pruneGraph({ version: 1, updatedAt: now, nodes, edges, reports }), stats };
}

/** 节点超限裁剪：丢弃最旧且近 90 天未被引用的实体节点（主题/报告节点不裁剪） */
function pruneGraph(graph: KnowledgeGraph): KnowledgeGraph {
  if (graph.nodes.length <= MAX_NODES) return graph;
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const referencedIds = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const removable = graph.nodes
    .filter(
      (n) =>
        n.type === "entity" &&
        Date.parse(n.updatedAt) < cutoff &&
        !referencedIds.has(n.id),
    )
    .map((n) => n.id);
  const overflow = graph.nodes.length - MAX_NODES;
  const toDrop = new Set(removable.slice(0, overflow));
  if (toDrop.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !toDrop.has(n.id)),
    edges: graph.edges.filter((e) => !toDrop.has(e.source) && !toDrop.has(e.target)),
  };
}
