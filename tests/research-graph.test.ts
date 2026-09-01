import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { emptyGraph, normalizeNodeLabel, parseGraphPatch, type GraphPatch, type GraphReportRef } from "@/lib/server/research-graph/types";
import { mergeGraph, loadGraph, saveGraph } from "@/lib/server/research-graph/store";
import { queryGraph, tokenize } from "@/lib/server/research-graph/query";
import { verifyCitationIntegrity, extractCitationNos } from "@/lib/server/research-graph/review";
import { graphContextBlock } from "@/lib/server/agents/prompts";

/**
 * 研究知识图谱（Understand-Anything 融合）纯函数层测试
 * LLM 抽取注入点（extractGraphPatch / deep-research.ts 编排）依赖网关，走集成验证
 */

function makeRef(questionId: string): GraphReportRef {
  return {
    questionId,
    question: `${questionId} 的研究问题`,
    objective: `${questionId} 的研究目标`,
    summary: "",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

const PATCH_A: GraphPatch = {
  summary: "TikTok 东南亚竞价成本 2026Q2 上涨 18%",
  entities: [
    { label: "TikTok", summary: "短视频投放渠道，竞价成本上涨" },
    { label: "tiktok ", summary: "归一化后应命中同一实体" },
  ],
  topics: [{ label: "广告竞价成本", summary: "渠道竞价环境主题" }],
  relations: [{ source: "TikTok", target: "东南亚市场", relation: "投放于" }],
};

describe("normalizeNodeLabel", () => {
  it("大小写与空格差异归一化为同一键", () => {
    expect(normalizeNodeLabel("TikTok")).toBe(normalizeNodeLabel("tiktok "));
    expect(normalizeNodeLabel("ＴｉｋＴｏｋ")).toBe(normalizeNodeLabel("tiktok"));
  });
});

describe("mergeGraph（增量合并）", () => {
  it("同名实体去重、主题与 report 节点入图、关系边按三元组去重", () => {
    const { graph, stats } = mergeGraph(emptyGraph(), PATCH_A, makeRef("question_1"));

    // 实体：TikTok（两次出现去重为 1）+ 东南亚市场（关系端点自动补建）；主题 1；report 1
    expect(stats.addedNodes).toBe(4);
    // 更新 2 次：同名实体「tiktok 」命中去重 + 关系端点「TikTok」命中已有节点
    expect(stats.updatedNodes).toBe(2);
    const tiktok = graph.nodes.filter((n) => n.type === "entity" && normalizeNodeLabel(n.label) === "tiktok");
    expect(tiktok).toHaveLength(1);
    expect(tiktok[0]!.reportIds).toEqual(["question_1"]);
    // 摘要以最新为准（第二个同名实体覆盖）
    expect(tiktok[0]!.summary).toContain("归一化");
    // report → topic 自动补「研究涉及」边 + 抽取的关系边
    expect(stats.addedEdges).toBe(2);
    expect(graph.edges.some((e) => e.relation === "研究涉及")).toBe(true);
    expect(graph.edges.some((e) => e.relation === "投放于")).toBe(true);
    // reports 落库（摘要取补丁 summary）
    expect(graph.reports).toHaveLength(1);
    expect(graph.reports[0]!.summary).toContain("竞价成本");
  });

  it("第二次研究合并：实体 reportIds 并集、同三元组边不重复", () => {
    const first = mergeGraph(emptyGraph(), PATCH_A, makeRef("question_1"));
    const second = mergeGraph(first.graph, PATCH_A, makeRef("question_2"));

    const tiktok = second.graph.nodes.find(
      (n) => n.type === "entity" && normalizeNodeLabel(n.label) === "tiktok",
    );
    expect(tiktok!.reportIds).toEqual(["question_1", "question_2"]);
    // 「投放于」边不新增，reportIds 并集
    const relEdges = second.graph.edges.filter((e) => e.relation === "投放于");
    expect(relEdges).toHaveLength(1);
    expect(relEdges[0]!.reportIds).toEqual(["question_1", "question_2"]);
    expect(second.graph.reports).toHaveLength(2);
  });

  it("不修改传入的基础图谱对象", () => {
    const base = emptyGraph();
    mergeGraph(base, PATCH_A, makeRef("question_1"));
    expect(base.nodes).toHaveLength(0);
    expect(base.edges).toHaveLength(0);
    expect(base.reports).toHaveLength(0);
  });
});

describe("saveGraph / loadGraph（原子读写回环）", () => {
  it("保存后可原样加载；损坏文件降级为空图", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-"));
    const tmpFile = path.join(tmpDir, "knowledge-graph.json");
    process.env.RESEARCH_GRAPH_PATH = tmpFile;
    try {
      const { graph } = mergeGraph(emptyGraph(), PATCH_A, makeRef("question_1"));
      await saveGraph(graph);
      const loaded = await loadGraph();
      expect(loaded.nodes.length).toBe(graph.nodes.length);
      expect(loaded.reports).toHaveLength(1);

      await fs.writeFile(tmpFile, "{ 损坏的 JSON", "utf-8");
      const broken = await loadGraph();
      expect(broken.nodes).toHaveLength(0);
    } finally {
      delete process.env.RESEARCH_GRAPH_PATH;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("queryGraph（图谱检索）", () => {
  const { graph } = mergeGraph(emptyGraph(), PATCH_A, makeRef("question_1"));

  it("按词元重叠召回相关节点与历史研究", () => {
    const hits = queryGraph(graph, "TikTok 竞价成本为什么上涨？");
    expect(hits.nodes.length).toBeGreaterThan(0);
    const labels = hits.nodes.map((n) => normalizeNodeLabel(n.label));
    expect(labels).toContain("tiktok");
    expect(labels).toContain("广告竞价成本");
    expect(hits.reports.map((r) => r.questionId)).toContain("question_1");
  });

  it("无重叠时返回空结果", () => {
    const hits = queryGraph(graph, "供应链合规风险评估");
    expect(hits.nodes).toHaveLength(0);
    expect(hits.reports).toHaveLength(0);
  });

  it("空图直接返回空结果", () => {
    const hits = queryGraph(emptyGraph(), "TikTok 竞价成本");
    expect(hits.nodes).toHaveLength(0);
  });
});

describe("tokenize", () => {
  it("英文按单词、中文按 2-3 字滑窗切分", () => {
    const tokens = tokenize("TikTok 竞价成本上涨");
    expect(tokens.has("tiktok")).toBe(true);
    expect(tokens.has("竞价")).toBe(true);
    expect(tokens.has("成本")).toBe(true);
    expect(tokens.has("竞价成")).toBe(true);
  });
});

describe("verifyCitationIntegrity（引用完整性）", () => {
  const citations = [
    { no: 1, title: "来源A", url: "https://a.example" },
    { no: 2, title: "来源B", url: "https://b.example" },
  ];

  it("正文引用全部存在时通过", () => {
    const review = verifyCitationIntegrity("结论甲 [1]，结论乙 [2]", citations);
    expect(review.passed).toBe(true);
    expect(review.issues).toHaveLength(0);
  });

  it("悬挂引用判不通过并给出问题描述", () => {
    const review = verifyCitationIntegrity("结论甲 [1]，结论乙 [9]", citations);
    expect(review.passed).toBe(false);
    expect(review.issues.join()).toContain("[9]");
  });

  it("引用表为空判不通过", () => {
    const review = verifyCitationIntegrity("结论 [1]", []);
    expect(review.passed).toBe(false);
  });

  it("未被正文引用的来源仅提示可精简，不影响通过", () => {
    const review = verifyCitationIntegrity("结论甲 [1]", citations);
    expect(review.passed).toBe(true);
    expect(review.issues.join()).toContain("可精简");
  });

  it("extractCitationNos 仅取正整数编号", () => {
    expect(extractCitationNos("见 [1][2] 与 [0] 和 [x]")).toEqual([1, 2]);
  });
});

describe("parseGraphPatch（抽取输出解析）", () => {
  const valid = {
    summary: "摘要",
    entities: [{ label: "TikTok", summary: "渠道" }, { label: "  ", summary: "空名应被过滤" }],
    topics: [{ label: "广告竞价成本", summary: "主题" }],
    relations: [
      { source: "TikTok", target: "广告竞价成本", relation: "受…驱动" },
      { source: "只有端点", relation: "缺 target 应被过滤" },
    ],
  };

  it("解析裸 JSON 并过滤非法条目", () => {
    const patch = parseGraphPatch(JSON.stringify(valid));
    expect(patch).not.toBeNull();
    expect(patch!.summary).toBe("摘要");
    expect(patch!.entities.map((e) => e.label)).toEqual(["TikTok"]);
    expect(patch!.relations).toHaveLength(1);
  });

  it("容忍 markdown 代码块包裹", () => {
    const patch = parseGraphPatch("```json\n" + JSON.stringify(valid) + "\n```");
    expect(patch!.topics[0]!.label).toBe("广告竞价成本");
  });

  it("容忍前后杂讯中的 JSON 片段", () => {
    const patch = parseGraphPatch(`抽取结果如下：${JSON.stringify(valid)}（以上）`);
    expect(patch!.entities).toHaveLength(1);
  });

  it("无有效内容或无法解析时返回 null", () => {
    expect(parseGraphPatch("完全无法解析的文本")).toBeNull();
    expect(parseGraphPatch(JSON.stringify({ summary: "", entities: [], topics: [] }))).toBeNull();
  });
});

describe("graphContextBlock（图谱背景注入）", () => {
  it("无命中时返回空串（不注入）", () => {
    expect(graphContextBlock({ nodes: [], reports: [] })).toBe("");
  });

  it("命中时组装历史研究与实体清单", () => {
    const block = graphContextBlock({
      nodes: [
        { label: "TikTok", type: "entity", summary: "竞价成本上涨" },
        { label: "广告竞价成本", type: "topic", summary: "" },
      ],
      reports: [
        { question: "TikTok 竞价成本为什么上涨", summary: "2026Q2 上涨 18%", createdAt: "2026-08-20T00:00:00Z" },
      ],
    });
    expect(block).toContain("研究知识图谱背景");
    expect(block).toContain("[2026-08-20]");
    expect(block).toContain("2026Q2 上涨 18%");
    expect(block).toContain("TikTok（竞价成本上涨）");
    expect(block).toContain("广告竞价成本");
  });

  it("总长硬截断 2000 字", () => {
    const block = graphContextBlock({
      nodes: Array.from({ length: 200 }, (_, i) => ({
        label: `实体${i}`,
        type: "entity",
        summary: "摘".repeat(60),
      })),
      reports: [],
    });
    expect(block.length).toBeLessThanOrEqual(2000);
  });
});
