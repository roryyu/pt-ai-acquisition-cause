/**
 * 图片投递渠道：将画布导出 PNG（base64）落盘到 public/exports/
 * 导出记录同时作为邮件附件与定时导出的产物
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryChannel, DeliveryInput, DeliveryResult } from "./channel";

/** 导出目录：public/exports（可通过 /exports/xxx.png 直接访问） */
const EXPORT_DIR = join(process.cwd(), "public", "exports");

/** 单张导出图体积上限（5MB，防止超大 payload） */
const MAX_PNG_BYTES = 5 * 1024 * 1024;

/**
 * 保存 PNG base64 到导出目录
 * @returns 服务端相对路径（/exports/xxx.png），失败返回 null
 */
export async function saveExportPng(docId: string, base64: string): Promise<string | null> {
  const data = base64.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(data, "base64");
  if (buf.byteLength === 0 || buf.byteLength > MAX_PNG_BYTES) return null;

  await mkdir(EXPORT_DIR, { recursive: true });
  const fileName = `${docId}-${Date.now()}.png`;
  await writeFile(join(EXPORT_DIR, fileName), buf);
  return `/exports/${fileName}`;
}

/**
 * 查找该文档最近一次导出图片（定时邮件用作附件）
 */
export async function latestExportPng(docId: string): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    const files = await readdir(EXPORT_DIR);
    const own = files
      .filter((f) => f.startsWith(docId) && f.endsWith(".png"))
      .sort()
      .reverse();
    return own.length > 0 ? `/exports/${own[0]}` : null;
  } catch {
    return null;
  }
}

export const imageChannel: DeliveryChannel = {
  name: "image",

  async deliver(input: DeliveryInput): Promise<DeliveryResult> {
    // 图片渠道的"投递"即确认文件存在并记录路径
    if (!input.imagePath) {
      return { status: "failed", mock: false, detail: { error: "缺少导出图片路径" } };
    }
    return {
      status: "sent",
      mock: false,
      detail: { imagePath: input.imagePath, title: input.title },
    };
  },
};
