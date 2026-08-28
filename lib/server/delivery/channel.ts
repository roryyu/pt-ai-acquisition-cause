/**
 * 投递渠道抽象层（项目规范：邮件/图片发送统一走渠道接口）
 * 本期 SMTP 未接入，email 渠道降级为落盘 mock；SMTP_HOST 配置后预留 nodemailer 接入点。
 */

/** 投递输入：目标文档 + 收件人 + 可选图片/正文素材 */
export interface DeliveryInput {
  docId: string;
  title: string;
  /** 收件人列表（email 渠道必填） */
  recipients: string[];
  /** 画布导出 PNG 的服务端相对路径（如 /exports/insight_xxx.png），可选 */
  imagePath?: string;
  /** Markdown 正文（从画布 snapshot 提取），可选 */
  markdown?: string;
}

/** 投递结果 */
export interface DeliveryResult {
  status: "sent" | "failed";
  /** 是否为 mock 落盘（SMTP 未接入时为 true） */
  mock: boolean;
  detail: Record<string, unknown>;
}

/** 投递渠道接口：email / image 均实现此契约 */
export interface DeliveryChannel {
  name: "email" | "image";
  deliver(input: DeliveryInput): Promise<DeliveryResult>;
}
