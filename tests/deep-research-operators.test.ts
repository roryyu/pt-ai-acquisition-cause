import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 深度研究算子化链路测试（design.md 5.2.2 研究算子接入 4.3.2 工作流）
 *
 * 隔离算子注册表与模型网关：验证 runDeepResearch 经 runOperator
 * 调度 search / extract / compare 三个研究算子，以及状态机含 analyzing、
 * 算子失败时的静默降级路径。
 */

vi.mock("@/lib/server/operators/registry", () => ({
  runOperator: vi.fn(),
}));
vi.mock("@/lib/server/model-gateway", () => ({
  chatCompletion: vi.fn(),
  chatCompletionStream: vi.fn(),
}));

import { runOperator } from "@/lib/server/operators/registry";
import { chatCompletion, chatCompletionStream } from "@/lib/server/model-gateway";
import { runDeepResearch } from "@/lib/server/agents/deep-research";
import type { AgentEvent } from "@/lib/server/agents/events";
import type { OperatorRunResult } from "@/lib/server/operators/data-operators";

const runOperatorMock = vi.mocked(runOperator);
const chatCompletionMock = vi.mocked(chatCompletion);
const chatCompletionStreamMock = vi.mocked(chatCompletionStream);

const PLAN_JSON = JSON.stringify({
  objective: "测试研究目标",
  subQuestions: [
    { question: "子问题一", rationale: "理由一", keywords: ["关键词A"] },
    { question: "子问题二", rationale: "理由二", keywords: ["关键词B"] },
  ],
});

const FINDINGS_JSON = JSON.stringify({
  findings: ["发现甲：某数据 123 [1]", "发现乙：某结论 [2]"],
});

function okResult(rows: Record<string, unknown>[], columns: string[]): OperatorRunResult {
  return { ok: true, operatorId: "", columns, rows, rowCount: rows.length, elapsedMs: 1, notes: [] };
}

function failResult(error: string): OperatorRunResult {
  return { ok: false, operatorId: "", columns: [], rows: [], rowCount: 0, elapsedMs: 1, notes: [], error };
}

const SEARCH_ROWS = [
  { title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" },
  { title: "来源二", url: "https://b.example.com/2", snippet: "摘要二" },
];

/** 正常路径：search/extract/compare 算子全部成功 */
function mockOperatorsHappyPath() {
  runOperatorMock.mockImplementation(async (id: string) => {
    if (id === "search") return okResult(SEARCH_ROWS, ["title", "url", "snippet"]);
    if (id === "extract") return okResult([
      { point: "要点一", quote: "2026 年 6 月，东南亚样本渠道 CPI 为 2 美元。" },
      { point: "要点二", quote: "统计仅包含 Android，不代表全部市场。" },
    ], ["point", "quote"]);
    if (id === "compare") return okResult([{ comparison: "共识：X；分歧：Y；置信度：中" }], ["comparison"]);
    return failResult(`未知算子 ${id}`);
  });
}

/** 网关：首调返回规划，其后返回证据抽取结果；报告流式两段 */
function mockGateway() {
  let calls = 0;
  chatCompletionMock.mockImplementation(async () => {
    calls += 1;
    return calls === 1 ? PLAN_JSON : FINDINGS_JSON;
  });
  chatCompletionStreamMock.mockImplementation(
    (async function* () {
      yield "# 研究报告\n";
      yield "正文内容";
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGateway();
});

async function run(depth: "standard" | "deep" = "standard") {
  const events: AgentEvent[] = [];
  const states: string[] = [];
  const result = await runDeepResearch({
    questionId: "question_test",
    question: "测试研究问题",
    depth,
    sink: (event) => events.push(event),
    onStateChange: (state) => {
      states.push(state);
    },
  });
  return { result, events, states };
}

describe("深度研究算子化链路", () => {
  it("检索与深读经算子注册表调度（search / extract）", async () => {
    mockOperatorsHappyPath();
    const { result } = await run();

    const searchCalls = runOperatorMock.mock.calls.filter((c) => c[0] === "search");
    const extractCalls = runOperatorMock.mock.calls.filter((c) => c[0] === "extract");
    // 每个子问题 2 次检索（问题 + 关键词），共 4 次
    expect(searchCalls).toHaveLength(4);
    expect(searchCalls[0]![1]).toMatchObject({ query: "子问题一", maxResults: 6 });
    // 每个子问题深读排名前 2 的结果
    expect(extractCalls).toHaveLength(4);
    expect(extractCalls[0]![1]).toMatchObject({ url: "https://a.example.com/1", focus: "子问题一" });
    expect(result.citations.map((c) => c.url)).toEqual([
      "https://a.example.com/1",
      "https://b.example.com/2",
    ]);
  });

  it("状态机含 analyzing，compare 算子结论注入报告生成", async () => {
    mockOperatorsHappyPath();
    const { result, states, events } = await run();

    expect(states).toEqual(["planning", "collecting", "analyzing", "writing", "completed"]);
    const compareCalls = runOperatorMock.mock.calls.filter((c) => c[0] === "compare");
    expect(compareCalls).toHaveLength(1);
    expect(compareCalls[0]![1]).toMatchObject({ topic: "测试研究目标" });
    // 比对结论注入 Synthesizer 的 user 消息
    const streamCall = chatCompletionStreamMock.mock.calls[0];
    const userMsg = streamCall?.[0]?.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("多源比对结论（CompareOp 算子）");
    expect(userMsg).toContain("共识：X；分歧：Y");
    // compare 工具事件可观测
    expect(events.some((e) => e.type === "tool_call" && e.tool === "compare")).toBe(true);
    expect(events.some((e) => e.type === "phase" && e.phase === "analyzing")).toBe(true);
    expect(result.report).toBe("# 研究报告\n正文内容");
  });

  it("检索算子失败时静默降级：不深读、不比对，任务仍完成", async () => {
    runOperatorMock.mockImplementation(async (id: string) => {
      if (id === "search") return failResult("网络不可用");
      return failResult("不应被调用");
    });
    // 无材料时抽取产出空发现 → 子问题走无证据兜底文案，不触发比对
    let calls = 0;
    chatCompletionMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? PLAN_JSON : JSON.stringify({ findings: [] });
    });
    const { result, states } = await run();

    const ids = runOperatorMock.mock.calls.map((c) => c[0]);
    expect(ids).toContain("search");
    expect(ids).not.toContain("extract");
    expect(ids).not.toContain("compare");
    // 无证据兜底发现
    for (const sub of result.subQuestions) {
      expect(sub.findings[0]).toContain("未检索到能直接回答");
    }
    expect(states).toEqual(["planning", "collecting", "analyzing", "writing", "completed"]);
    expect(result.report).toBe("# 研究报告\n正文内容");
  });

  it("compare 算子失败时静默降级：报告照常生成且不注入比对块", async () => {
    runOperatorMock.mockImplementation(async (id: string) => {
      if (id === "search") return okResult(SEARCH_ROWS, ["title", "url", "snippet"]);
      if (id === "extract") return okResult([{ point: "要点一" }], ["point"]);
      if (id === "compare") return failResult("LLM 超时");
      return failResult(`未知算子 ${id}`);
    });
    const { result } = await run();

    const streamCall = chatCompletionStreamMock.mock.calls[0];
    const userMsg = streamCall?.[0]?.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).not.toContain("多源比对结论");
    expect(result.report).toBe("# 研究报告\n正文内容");
  });

  // 长摘要不再被误判为「已深读」：旧逻辑用 text.length>300 跳过 ExtractOp，
  // 这里长摘要来源仍会尝试深读，失败后按去重结果补足下一来源。
  it("长摘要仍深读；锚点重复归一后不占额度；深读失败补足下一来源", async () => {
    const rows = [
      { title: "来源一", url: "https://a.example.com/1#intro", snippet: "长摘要".repeat(200) },
      { title: "来源一重复", url: "https://a.example.com/1#details", snippet: "重复" },
      SEARCH_ROWS[1]!,
      { title: "来源三", url: "https://c.example.com/3", snippet: "摘要三" },
    ];
    runOperatorMock.mockImplementation(async (id, input) => {
      if (id === "search") return okResult(rows, ["title", "url", "snippet"]);
      if (id === "extract") {
        // 归一后 a.example.com/1 深读失败，b、c 成功
        if ((input as { url: string }).url === "https://a.example.com/1") return failResult("抓取失败");
        return okResult([{ point: "要点", quote: "原文中实际提供的事实与限定条件。" }], ["point", "quote"]);
      }
      return failResult("跳过比对");
    });
    const { result } = await run();
    for (const sub of result.subQuestions) {
      const urls = runOperatorMock.mock.calls
        .filter(([id, input]) => id === "extract" && (input as { focus: string }).focus === sub.question)
        .map(([, input]) => (input as { url: string }).url);
      // 锚点重复的 a.example.com/1#details 被归一去重，未额外占用深读额度
      expect(urls).toEqual(["https://a.example.com/1", "https://b.example.com/2", "https://c.example.com/3"]);
      // a/1 深读失败保留为未核对摘要，b/2、c/3 成功保留为正文摘录
      expect(sub.evidence?.filter((m) => m.kind === "page_excerpt")).toHaveLength(2);
      expect(sub.evidence?.find((m) => m.no === 1)?.kind).toBe("search_snippet");
    }
    // 三个不同 URL 各登记一次引用（锚点重复不额外计数）
    expect(result.citations).toHaveLength(3);
  });

  // 抽取只返回模型改写要点、无原文 quote 时不算深读成功，补抓次数有硬上限（deepReadCount*2）
  it.each(["standard", "deep"] as const)("%s：无原文摘录不算深读成功，补抓次数封顶", async (depth) => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ title: `来源${i}`, url: `https://a.example.com/${i}`, snippet: "摘要" }));
    runOperatorMock.mockImplementation(async (id) => {
      if (id === "search") return okResult(rows, ["title", "url", "snippet"]);
      if (id === "extract") return okResult([{ point: "只有模型改写，无原文" }], ["point"]);
      return failResult("跳过比对");
    });
    const { result } = await run(depth);
    const deepReadCount = depth === "deep" ? 3 : 2;
    const cap = deepReadCount * 2; // 每子问题最多尝试页数
    for (const sub of result.subQuestions) {
      const calls = runOperatorMock.mock.calls.filter(
        ([id, input]) => id === "extract" && (input as { focus: string }).focus === sub.question,
      );
      expect(calls).toHaveLength(cap);
      // 全程无 page_excerpt 证据（quote 缺失），子问题仍完成但不产出正文摘录
      expect(sub.evidence?.filter((m) => m.kind === "page_excerpt")).toHaveLength(0);
    }
  });
});
