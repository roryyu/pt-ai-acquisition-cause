/**
 * 邮件投递渠道
 * - SMTP_HOST 已配置：预留 nodemailer 接入点（TODO 下期实装）
 * - 未配置（本期）：降级为落盘 mock，将邮件内容写入 .deliveries/ 目录并返回 sent
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryChannel, DeliveryInput, DeliveryResult } from "./channel";

/** 邮件落盘目录（项目根/.deliveries，gitignore 已忽略点目录） */
const DELIVERY_DIR = join(process.cwd(), ".deliveries");

/** 判断 SMTP 是否已配置（下期接入 nodemailer 的开关） */
export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}

export const emailChannel: DeliveryChannel = {
  name: "email",

  async deliver(input: DeliveryInput): Promise<DeliveryResult> {
    if (input.recipients.length === 0) {
      return {
        status: "failed",
        mock: false,
        detail: { error: "收件人列表为空" },
      };
    }

    // TODO: SMTP_HOST 配置后接入 nodemailer（transporter.sendMail），本期走落盘 mock
    try {
      await mkdir(DELIVERY_DIR, { recursive: true });
      const ts = Date.now();
      const fileName = `email-${input.docId}-${ts}.md`;
      const body = [
        `# ${input.title}`,
        "",
        `> 收件人：${input.recipients.join(", ")}`,
        `> 附件图片：${input.imagePath ?? "（无）"}`,
        `> 生成时间：${new Date().toISOString()}`,
        "",
        input.markdown ?? "（画布无文本内容，请查看附件图片）",
      ].join("\n");
      await writeFile(join(DELIVERY_DIR, fileName), body, "utf-8");

      return {
        status: "sent",
        mock: true,
        detail: {
          recipients: input.recipients,
          ...(input.imagePath ? { attachment: input.imagePath } : {}),
          file: `.deliveries/${fileName}`,
          note: "SMTP 未接入，邮件内容已落盘",
        },
      };
    } catch (error) {
      return {
        status: "failed",
        mock: true,
        detail: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  },
};
