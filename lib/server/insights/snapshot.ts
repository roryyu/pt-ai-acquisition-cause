/**
 * tldraw snapshot 文本提取：用于邮件正文与定时导出摘要
 * 兼容两种 store 结构：
 * - 编辑器快照（getSnapshot 产物）：{ store: { "shape:xxx": { ... } } }
 * - 迁移/初始快照：{ store: [ { ... }, ... ] }
 */

/** 从 snapshot 中提取可读文本（按形状出现顺序拼接） */
export function extractTextFromSnapshot(snapshot: unknown): string {
  if (typeof snapshot !== "object" || snapshot === null) return "";
  const store = (snapshot as { store?: unknown }).store;

  // 归一化：映射形式取 values，数组形式直接用
  let records: unknown[];
  if (Array.isArray(store)) {
    records = store;
  } else if (store && typeof store === "object") {
    records = Object.values(store as Record<string, unknown>);
  } else {
    return "";
  }

  const lines: string[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const rec = record as { typeName?: string; type?: string; props?: Record<string, unknown> };
    if (rec.typeName !== "shape" || !rec.props) continue;

    // 原生文本/便签形状
    if (rec.type === "text" && typeof rec.props.text === "string" && rec.props.text.trim()) {
      lines.push(rec.props.text.trim());
    }
    if (rec.type === "note" && typeof rec.props.text === "string" && rec.props.text.trim()) {
      lines.push(`【便签】${rec.props.text.trim()}`);
    }
    // 自定义实时内容形状：取 payload 的标题与正文
    if (rec.type === "live-content") {
      const payload = rec.props.payload as { title?: string; text?: string } | undefined;
      if (payload?.title) lines.push(`## ${payload.title}`);
      if (payload?.text) lines.push(payload.text.slice(0, 800));
    }
  }
  return lines.join("\n\n");
}
