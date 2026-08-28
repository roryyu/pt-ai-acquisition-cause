import { z } from "zod";
import { handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { listOperators, getOperator, runOperator } from "@/lib/server/operators/registry";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * GET /api/v1/operators — 算子注册表（含参数 Schema，供 UI 动态渲染试运行表单）
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const operators = listOperators();
    return ok({
      operators: operators.map((op) => ({
        ...op,
        params: op.params,
      })),
      total: operators.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 算子试运行请求 */
const RunOperatorSchema = z.object({
  operatorId: z.string().min(1),
  input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()])),
});

/**
 * POST /api/v1/operators/run — 算子试运行（真实执行，返回 SQL/结果/耗时）
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);
    const { operatorId, input } = RunOperatorSchema.parse(await readJson<unknown>(request));

    const meta = getOperator(operatorId);
    if (!meta) {
      return handleApiError({ status: 404, code: "OPERATOR_NOT_FOUND", message_: `算子不存在: ${operatorId}` });
    }

    const result = await runOperator(operatorId, input);
    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
