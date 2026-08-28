/**
 * 洞察画布共享类型（客户端/服务端同构，不含任何服务端依赖）
 */
import type { ChartSpec, TablePayload, Citation } from "@/lib/agent-events";

/** 画布实时内容负载（CanvasBinding.payload 与 LiveContentShape props 同构） */
export interface LivePayload {
  /** 内容类别：chart=图表为主 / text=正文为主 / research=研究报告 */
  kind: "chart" | "text" | "research";
  /** 内容标题（问题或研究主题） */
  title: string;
  /** 正文（Markdown） */
  text?: string;
  /** 图表列表 */
  charts?: ChartSpec[];
  /** 表格列表 */
  tables?: TablePayload[];
  /** 引用列表 */
  citations?: Citation[];
}

/** 画布绑定记录（API 返回结构的客户端视图） */
export interface BindingView {
  id: string;
  docId: string;
  shapeId: string;
  sourceType: "question" | "research" | "metric";
  sourceId: string | null;
  payload: LivePayload;
  sourceStatus: string;
  updatedAt: string;
}

/** 判断源状态是否仍在运行中（画布徽标显示"更新中"） */
export function isSourceRunning(sourceStatus: string): boolean {
  return !["completed", "failed", "unknown", "deleted"].includes(sourceStatus);
}

/** 判断源是否已被删除（卡片保留最后内容，徽标显示"源已删除"） */
export function isSourceDeleted(sourceStatus: string): boolean {
  return sourceStatus === "deleted";
}

/** 源状态中文标签 */
export function sourceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    queued: "排队中",
    planning: "规划中",
    collecting: "检索中",
    analyzing: "分析中",
    verifying: "校验中",
    writing: "撰写中",
    reviewing: "审阅中",
    completed: "已完成",
    failed: "失败",
    unknown: "未知",
    deleted: "源已删除",
  };
  return map[status] ?? status;
}
