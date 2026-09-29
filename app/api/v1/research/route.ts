import { z } from "zod";
import { handleApiError, ok, readJson, requireActor, parsePagination } from "@/lib/server/api-runtime";
import { sseResponse } from "@/lib/server/sse";
import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { runDeepResearch } from "@/lib/server/agents/deep-research";
import { researchSourceContextBlock, graphContextBlock } from "@/lib/server/agents/prompts";
import { loadGraph } from "@/lib/server/research-graph/store";
import { queryGraph } from "@/lib/server/research-graph/query";
import type { AgentEvent } from "@/lib/server/agents/events";
import { getDefaultModel } from "@/lib/server/model-gateway";

export const runtime = "nodejs";
export const maxDuration = 600;

/** 创建深度研究任务请求 */
const ResearchRequestSchema = z.object({
  question: z.string().min(4, "研究问题至少 4 个字").max(2000),
  depth: z.enum(["standard", "deep"]).default("standard"),
  workspaceId: z.string().optional(),
  /** 来源任务问答：任务问答「进行深入研究」时携带，其结果作为研究背景注入 */
  sourceQuestionId: z.string().optional(),
});

/**
 * POST /api/v1/research — 发起深度研究任务（design.md 4.3.2）
 *
 * Planner（拆解子问题）→ Executor（逐子问题检索+深读+证据抽取）→ Synthesizer（流式成稿）
 * SSE 推送 AgentEvent（plan/phase/step/tool_call/tool_result/citations/chunk/done）；
 * 主任务与每个子问题均持久化为 ResearchTask（可追踪、可回看）。
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const input = ResearchRequestSchema.parse(await readJson<unknown>(request));

    // 确保用户存在
    const existingUser = await prisma.user.findUnique({ where: { id: actor.id } });
    if (!existingUser) {
      await prisma.user.create({
        data: { id: actor.id, email: actor.email, name: actor.name, role: "admin" },
      });
    }

    const questionId = newId("question");
    const mainTaskId = newId("task");

    // 来源任务问答背景：优先压缩上下文摘要（含全会话背景），存量无摘要时截取回答原文；
    // 源问答不存在/未完成时静默降级为无背景研究，不阻断发起
    let sourceContext: string | undefined;
    if (input.sourceQuestionId) {
      const source = await prisma.question.findUnique({ where: { id: input.sourceQuestionId } });
      if (source && source.status === "completed") {
        const sourceAnswer = (source.answer ?? {}) as { content?: string; contextSummary?: string };
        const block = researchSourceContextBlock({
          question: source.content,
          contextSummary: sourceAnswer.contextSummary ?? null,
          answerContent: sourceAnswer.content ?? null,
        });
        if (block) sourceContext = block;
      }
    }

    // 研究知识图谱背景（Understand-Anything 融合）：检索图谱命中的历史研究与实体，
    // 注入 Planner 与报告生成，避免重复研究并在历史结论上延展；空图/无命中静默跳过
    let graphContext: string | undefined;
    try {
      const graph = await loadGraph();
      const hits = queryGraph(graph, input.question);
      const block = graphContextBlock(hits);
      if (block) graphContext = block;
    } catch {
      // 图谱不可用不影响研究发起
    }

    // 问答载体（承载最终报告）+ 主研究任务；sourceQuestionId 记录链路来源（可回溯）
    await prisma.question.create({
      data: {
        id: questionId,
        userId: actor.id,
        workspaceId: input.workspaceId || null,
        content: input.question,
        context: {
          kind: "deep_research",
          taskId: mainTaskId,
          depth: input.depth,
          ...(sourceContext && input.sourceQuestionId
            ? { sourceQuestionId: input.sourceQuestionId }
            : {}),
        },
        status: "planning",
      },
    });
    await prisma.researchTask.create({
      data: {
        id: mainTaskId,
        questionId,
        agentType: "supervisor",
        status: "planning",
        input: { question: input.question, depth: input.depth },
      },
    });

    return sseResponse(async (send) => {
      try {
        send({ type: "meta", questionId, model: getDefaultModel() });

        const result = await runDeepResearch({
          questionId,
          question: input.question,
          depth: input.depth,
          sourceContext,
          graphContext,
          sink: (event: AgentEvent) => send(event),
          onStateChange: async (state) => {
            await prisma.researchTask
              .update({ where: { id: mainTaskId }, data: { status: state } })
              .catch(() => {});
            await prisma.question
              .update({ where: { id: questionId }, data: { status: state } })
              .catch(() => {});
          },
          onSubTask: async (sub) => {
            // 每个子问题 → 子任务记录（parentTaskId 关联主任务）
            await prisma.researchTask
              .create({
                data: {
                  id: newId("task"),
                  questionId,
                  parentTaskId: mainTaskId,
                  agentType: "researcher",
                  status: "completed",
                  input: {
                    subQuestion: sub.question,
                    rationale: sub.rationale,
                    searchedQueries: sub.searchedQueries,
                  },
                  output: { findings: sub.findings, evidence: sub.evidence ?? [], citationNos: sub.citationNos, elapsedMs: sub.elapsedMs },
                  startedAt: new Date(Date.now() - sub.elapsedMs),
                  completedAt: new Date(),
                },
              })
              .catch((err) => console.warn("[RESEARCH] 子任务持久化失败:", err));
          },
        });

        // 持久化报告
        const answerPayload = JSON.parse(
          JSON.stringify({
            kind: "deep_research",
            content: result.report,
            objective: result.objective,
            subQuestions: result.subQuestions.map((s) => ({
              id: s.id,
              question: s.question,
              findings: s.findings,
              evidence: s.evidence ?? [],
              citationNos: s.citationNos,
              searchedQueries: s.searchedQueries,
              elapsedMs: s.elapsedMs,
            })),
            citations: result.citations,
            elapsedMs: result.elapsedMs,
            // 知识图谱沉淀统计与引用校验结论（供历史回看展示）
            ...(result.graphStats ? { graphStats: result.graphStats } : {}),
            ...(result.review ? { review: result.review } : {}),
          }),
        ) as object;
        await prisma.question.update({
          where: { id: questionId },
          data: { status: "completed", answer: answerPayload },
        });
        await prisma.researchTask.update({
          where: { id: mainTaskId },
          data: {
            status: "completed",
            output: {
              objective: result.objective,
              report: result.report,
              subQuestionCount: result.subQuestions.length,
            } as object,
            citations: JSON.parse(JSON.stringify(result.citations)) as object,
            completedAt: new Date(),
          },
        });

        send({ type: "done", questionId, elapsedMs: result.elapsedMs });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[RESEARCH] 深度研究异常:", errMsg);
        await prisma.question
          .update({
            where: { id: questionId },
            data: { status: "failed", answer: { kind: "deep_research", error: errMsg } },
          })
          .catch(() => {});
        await prisma.researchTask
          .update({ where: { id: mainTaskId }, data: { status: "failed", completedAt: new Date() } })
          .catch(() => {});
        send({ type: "error", message: `深度研究执行失败: ${errMsg}` });
      }
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * GET /api/v1/research — 深度研究任务列表（主任务）
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const { skip, take } = parsePagination(request.url);

    // 仅统计真正的深度研究任务：任务问答的 Agent 轨迹（supervisor/data_analyst/critic）
    // 同样以 parentTaskId 为空的 supervisor 记录写入 research_tasks，
    // 必须通过承载问答的 context.kind = deep_research 区分，否则会污染研究列表
    const listWhere = {
      parentTaskId: null,
      agentType: "supervisor" as const,
      question: { context: { path: ["kind"], equals: "deep_research" } },
    };

    const [tasks, total] = await Promise.all([
      prisma.researchTask.findMany({
        where: listWhere,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { question: { select: { id: true, content: true, answer: true } } },
      }),
      prisma.researchTask.count({ where: listWhere }),
    ]);

    const list = tasks.map((t) => {
      const answer = (t.question?.answer ?? {}) as { citations?: unknown[]; elapsedMs?: number };
      return {
        id: t.id,
        questionId: t.question?.id ?? null,
        question: t.question?.content ?? "",
        status: t.status,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        citationCount: Array.isArray(answer.citations) ? answer.citations.length : 0,
        elapsedMs: answer.elapsedMs ?? null,
        reportPreview:
          typeof (answer as { content?: string }).content === "string"
            ? (answer as { content?: string }).content!.slice(0, 160)
            : "",
      };
    });

    return ok({ tasks: list, total, page: Math.floor(skip / take) + 1, pageSize: take });
  } catch (error) {
    return handleApiError(error);
  }
}
