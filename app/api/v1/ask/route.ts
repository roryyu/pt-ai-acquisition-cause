import { z } from "zod";
import {
  handleApiError,
  ok,
  readJson,
  requireActor,
  parsePagination,
} from "@/lib/server/api-runtime";
import { sseResponse } from "@/lib/server/sse";
import { prisma, Prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { runAgentWorkflow } from "@/lib/server/agents/supervisor";
import { chatCompletion } from "@/lib/server/model-gateway";
import {
  CONTEXT_SUMMARY_PROMPT, CONTEXT_SUMMARY_MAX_LENGTH,
  composeContextSummaryInput, fallbackContextSummary,
} from "@/lib/server/agents/prompts";
import type { AgentEvent } from "@/lib/server/agents/events";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 提问请求 Schema */
const AskRequestSchema = z.object({
  question: z.string().min(1, "问题不能为空").max(2000),
  workspaceId: z.string().optional(),
  dataSourceIds: z.array(z.string()).optional(),
  /** 多轮追问：父问题 ID（取其问答构建对话历史） */
  parentQuestionId: z.string().optional(),
});

/**
 * POST /api/v1/ask — 创建问答并运行多 Agent 工作流（design.md 7.1）
 *
 * Supervisor 意图路由 →（数据分析 ReAct / 深度研究 ReAct + Critic / 直接回答）→ Synthesizer
 * 全程以 SSE 推送 AgentEvent：meta/phase/step/tool_call/tool_result/table/chart/chunk/citations/done
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const input = AskRequestSchema.parse(await readJson<unknown>(request));
    await ensureUserExists(actor);

    const questionId = newId("question");

    // 多轮追问：加载父问答的压缩上下文（首轮/存量无摘要时回退原始问答链）
    const { history, prevSummary } = await buildConversationContext(input.parentQuestionId);

    await prisma.question.create({
      data: {
        id: questionId,
        userId: actor.id,
        workspaceId: input.workspaceId || null,
        content: input.question,
        context: {
          // 显式标记为任务问答，与深度研究（kind: deep_research）在列表层区分；
          // 历史存量记录无 kind 字段，GET 列表已用 Prisma.DbNull 分支兼容
          kind: "ask",
          ...(input.dataSourceIds ? { dataSourceIds: input.dataSourceIds } : {}),
          ...(input.parentQuestionId ? { parentQuestionId: input.parentQuestionId } : {}),
        },
        status: "analyzing",
      },
    });

    return sseResponse(async (send) => {
      try {
        const result = await runAgentWorkflow({
          questionId,
          question: input.question,
          history,
          sink: (event: AgentEvent) => send(event),
        });

        // 完成一轮对话后增量压缩会话上下文（已有摘要 + 本轮问答），供下一轮追问复用
        const contextSummary = await compressConversationContext(
          prevSummary, input.question, result.finalAnswer,
        );

        // 持久化最终答案（含图表/表格/引用/SQL，供历史回看与报告复用）
        // JSON.parse(JSON.stringify()) 将 TS interface 归一化为纯 JSON 值（Prisma Json 字段要求）
        const answerPayload = JSON.parse(
          JSON.stringify({
            content: result.finalAnswer,
            route: result.route,
            charts: result.dataFindings.charts,
            tables: result.dataFindings.tables,
            sql: result.dataFindings.sql,
            citations: result.researchFindings.citations,
            critique: result.critique,
            elapsedMs: result.elapsedMs,
            contextSummary,
          }),
        ) as object;
        await prisma.question.update({
          where: { id: questionId },
          data: { status: "completed", answer: answerPayload },
        });

        // 记录 Agent 执行轨迹（supervisor 路由 + 各 worker 摘要 + critic 校验）
        await persistAgentTasks(questionId, input.question, result).catch((err) => {
          console.warn("[ASK] Agent 轨迹持久化失败:", err);
        });

        send({ type: "done", questionId, elapsedMs: result.elapsedMs });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[ASK] Agent 工作流异常:", errMsg);
        await prisma.question
          .update({
            where: { id: questionId },
            data: { status: "failed", answer: { error: errMsg } },
          })
          .catch(() => {});
        send({ type: "error", message: `Agent 工作流执行失败: ${errMsg}` });
      }
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * GET /api/v1/ask — 获取问答列表
 */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const { skip, take } = parsePagination(request.url);

    const listWhere = {
      userId: actor.id,
      // 排除深度研究承载的问答：kind 缺失（普通任务问答）或显式为 ask 均保留。
      // 注意：不能用 NOT{path equals} 单条件——PostgreSQL 中 kind 缺失时表达式为 NULL，
      // NOT NULL 仍为 NULL，会把全部普通问答一并过滤掉（历史列表为空的根因）
      OR: [
        { context: { path: ["kind"], equals: "ask" } },
        { context: { path: ["kind"], equals: Prisma.DbNull } },
      ],
    };

    const [questions, total] = await Promise.all([
      prisma.question.findMany({
        where: listWhere,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          content: true,
          status: true,
          createdAt: true,
          answer: true,
          context: true,
        },
      }),
      prisma.question.count({ where: listWhere }),
    ]);

    // 列表瘦身：不传回大体积 charts/tables
    const slim = questions.map((q) => {
      const answer = (q.answer ?? {}) as {
        content?: string;
        route?: string;
        charts?: unknown[];
        critique?: { score?: number } | null;
        elapsedMs?: number;
      };
      const ctx = (q.context ?? {}) as { parentQuestionId?: string };
      return {
        id: q.id,
        content: q.content,
        status: q.status,
        createdAt: q.createdAt,
        route: answer.route ?? null,
        chartCount: Array.isArray(answer.charts) ? answer.charts.length : 0,
        critiqueScore: answer.critique?.score ?? null,
        elapsedMs: answer.elapsedMs ?? null,
        answerPreview: (answer.content ?? "").slice(0, 120),
        // 追问轮次标记（带父问答），侧边栏用于区分新话题与追问
        isFollowUp: Boolean(ctx.parentQuestionId),
      };
    });

    return ok({ questions: slim, total, page: Math.floor(skip / take) + 1, pageSize: take });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 构建多轮追问的会话上下文（父问答链）
 *
 * 优先使用父问答持久化的压缩摘要（每轮完成时生成，已含全链历史）；
 * 存量记录无摘要时回退为原始问答链回溯（最多 4 轮）。
 */
async function buildConversationContext(
  parentQuestionId?: string,
): Promise<{
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prevSummary: string | null;
}> {
  if (!parentQuestionId) return { history: [], prevSummary: null };
  const parent = await prisma.question.findUnique({ where: { id: parentQuestionId } });
  if (!parent) return { history: [], prevSummary: null };

  const answer = (parent.answer ?? {}) as { content?: string; contextSummary?: string };
  if (answer.contextSummary?.trim()) {
    // 压缩上下文作为对话历史注入（单条即含全链背景，避免长原文撑爆各节点窗口）
    return {
      history: [
        { role: "user", content: parent.content },
        { role: "assistant", content: `【会话上下文摘要】${answer.contextSummary}` },
      ],
      prevSummary: answer.contextSummary,
    };
  }

  // 兜底：存量记录无摘要，回溯原始问答链（最多 4 轮）
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let cursorId: string | null = parentQuestionId;
  for (let depth = 0; depth < 4 && cursorId; depth++) {
    const cursor = depth === 0 ? parent : await prisma.question.findUnique({ where: { id: cursorId } });
    if (!cursor) break;
    const cursorAnswer = (cursor.answer ?? {}) as { content?: string };
    if (cursorAnswer.content) history.unshift({ role: "assistant", content: cursorAnswer.content.slice(0, 2000) });
    history.unshift({ role: "user", content: cursor.content });
    const ctx = (cursor.context ?? {}) as { parentQuestionId?: string };
    cursorId = ctx.parentQuestionId ?? null;
  }
  return { history, prevSummary: null };
}

/**
 * 增量压缩会话上下文：已有摘要 + 本轮问答 → 新摘要（随 answer 落库）
 * LLM 调用失败时降级为机械拼接，不阻塞主流程。
 */
async function compressConversationContext(
  prevSummary: string | null,
  question: string,
  answerContent: string,
): Promise<string> {
  try {
    const summary = await chatCompletion(
      [
        { role: "system", content: CONTEXT_SUMMARY_PROMPT },
        { role: "user", content: composeContextSummaryInput(prevSummary, question, answerContent) },
      ],
      { temperature: 0, maxTokens: 800 },
    );
    const trimmed = summary.trim();
    return trimmed
      ? trimmed.slice(0, CONTEXT_SUMMARY_MAX_LENGTH)
      : fallbackContextSummary(prevSummary, question, answerContent);
  } catch (error) {
    console.warn("[ASK] 上下文压缩失败，采用机械拼接兜底:", error instanceof Error ? error.message : error);
    return fallbackContextSummary(prevSummary, question, answerContent);
  }
}

/** 将 Agent 执行轨迹写入 research_tasks（supervisor / worker / critic 各一条） */
async function persistAgentTasks(
  questionId: string,
  question: string,
  result: Awaited<ReturnType<typeof runAgentWorkflow>>,
): Promise<void> {
  const now = new Date();
  const tasks: Array<{
    id: string;
    agentType: "supervisor" | "data_analyst" | "researcher" | "critic";
    input: unknown;
    output: unknown;
    status: "completed";
  }> = [
    {
      id: newId("task"),
      agentType: "supervisor",
      input: { question },
      output: { route: result.route },
      status: "completed",
    },
  ];
  if (result.route === "data_analysis" && result.dataFindings.sql.length > 0) {
    tasks.push({
      id: newId("task"),
      agentType: "data_analyst",
      input: { question },
      output: { sql: result.dataFindings.sql, chartCount: result.dataFindings.charts.length },
      status: "completed",
    });
  }
  if (result.route === "research" && result.researchFindings.notes.length > 0) {
    tasks.push({
      id: newId("task"),
      agentType: "researcher",
      input: { question, searchedQueries: result.researchFindings.searchedQueries },
      output: { notes: result.researchFindings.notes },
      status: "completed",
    });
  }
  if (result.critique) {
    tasks.push({
      id: newId("task"),
      agentType: "critic",
      input: { question },
      output: result.critique,
      status: "completed",
    });
  }
  await prisma.researchTask.createMany({
    data: tasks.map((t) => ({
      id: t.id,
      questionId,
      agentType: t.agentType,
      status: t.status,
      input: t.input as object,
      output: t.output as object,
      startedAt: now,
      completedAt: now,
    })),
  });
}

/** 确保用户记录存在（开发阶段自动创建桩用户） */
async function ensureUserExists(actor: { id: string; name: string; email: string; role: string }) {
  const existing = await prisma.user.findUnique({ where: { id: actor.id } });
  if (!existing) {
    await prisma.user.create({
      data: {
        id: actor.id,
        email: actor.email,
        name: actor.name,
        role: "admin",
      },
    });
  }
}
