import { randomUUID } from "node:crypto";

/**
 * 带前缀的唯一 ID 生成器（项目规范 4.1：ID 前缀 prefix_ + UUID）
 * 示例：newId("question") → "question_a1b2c3d4-..."
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
