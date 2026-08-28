/**
 * 投递服务：统一入口 deliver()
 * 选择渠道执行投递，并将结果写入 DeliveryRecord 流水（delivery_records）
 */
import { prisma, Prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import type { DeliveryChannel, DeliveryInput, DeliveryResult } from "./channel";
import { emailChannel } from "./email-channel";
import { imageChannel } from "./image-channel";

export type { DeliveryInput, DeliveryResult, DeliveryChannel } from "./channel";
export { emailChannel, isSmtpConfigured } from "./email-channel";
export { imageChannel, saveExportPng, latestExportPng } from "./image-channel";

/** 渠道注册表（后续接 SMTP / IM 推送在此扩展） */
const CHANNELS: Record<string, DeliveryChannel> = {
  email: emailChannel,
  image: imageChannel,
};

/**
 * 执行一次投递并落流水
 * @returns DeliveryRecord 的创建结果（含状态与详情）
 */
export async function deliver(
  channelName: "email" | "image",
  input: DeliveryInput,
): Promise<{ id: string; status: string; detail: unknown }> {
  const channel = CHANNELS[channelName];
  if (!channel) {
    throw new Error(`未知投递渠道：${channelName}`);
  }

  // 先记 queued 流水，执行后回填状态
  const recordId = newId("delivery");
  await prisma.deliveryRecord.create({
    data: {
      id: recordId,
      docId: input.docId,
      channel: channelName,
      status: "queued",
      detail: { recipients: input.recipients },
    },
  });

  let result: DeliveryResult;
  try {
    result = await channel.deliver(input);
  } catch (error) {
    result = {
      status: "failed",
      mock: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  await prisma.deliveryRecord.update({
    where: { id: recordId },
    data: {
      status: result.status,
      detail: result.detail as Prisma.InputJsonValue,
    },
  });

  return { id: recordId, status: result.status, detail: result.detail };
}
