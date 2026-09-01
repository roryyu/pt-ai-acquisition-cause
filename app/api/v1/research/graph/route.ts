import { handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { loadGraph } from "@/lib/server/research-graph/store";

export const runtime = "nodejs";

/**
 * GET /api/v1/research/graph — 研究知识图谱全量数据（Understand-Anything 融合）
 *
 * 供深度研究页「研究知识图谱」面板可视化（SVG 径向图 + 历史研究列表）。
 * 图谱不存在/损坏时返回空图，前端展示引导文案。
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const graph = await loadGraph();
    return ok({
      updatedAt: graph.updatedAt,
      nodes: graph.nodes,
      edges: graph.edges,
      reports: [...graph.reports].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
      stats: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        reportCount: graph.reports.length,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
