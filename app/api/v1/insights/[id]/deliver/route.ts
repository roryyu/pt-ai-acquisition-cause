import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { deliver, latestExportPng } from "@/lib/server/delivery";
import { extractTextFromSnapshot } from "@/lib/server/insights/snapshot";

const DeliverSchema = z.object({
  channel: z.enum(["email"]).default("email"),
  /** 收件人列表（逗号分隔字符串或数组均可） */
  recipients: z.union([z.array(z.string().email()), z.string()]).refine(
    (v) => (typeof v === "string" ? v.trim().length > 0 : v.length > 0),
    { message: "收件人不能为空" },
  ),
});

/**
 * POST /api/v1/insights/[id]/deliver — 发送洞察文档（当前支持 email 渠道，SMTP 未接入时落盘 mock）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const input = DeliverSchema.parse(await readJson<unknown>(request));

    const doc = await prisma.insightDoc.findUnique({ where: { id } });
    if (!doc) throw new ApiError(404, "INSIGHT_NOT_FOUND", "洞察文档不存在");

    const recipients = typeof input.recipients === "string"
      ? input.recipients.split(/[,，;；\s]+/).filter(Boolean)
      : input.recipients;

    // 正文取画布文本摘要，附件取最近一次导出 PNG（若有）
    const markdown = extractTextFromSnapshot(doc.snapshot);
    const imagePath = await latestExportPng(id);

    const record = await deliver("email", {
      docId: id,
      title: doc.title,
      recipients,
      markdown: markdown || undefined,
      ...(imagePath ? { imagePath } : {}),
    });

    return ok(record, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
