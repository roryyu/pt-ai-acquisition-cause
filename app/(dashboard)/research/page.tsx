import type { Metadata } from "next";
import { ResearchClient } from "./client";

export const metadata: Metadata = { title: "深度研究" };

/**
 * ?fromQuestion={questionId} 深链：任务问答「进行深入研究」跳转时，
 * 自动加载源问答作为研究背景（用户再补充研究方向后发起）
 */
export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ fromQuestion?: string }>;
}) {
  const { fromQuestion } = await searchParams;
  return <ResearchClient initialSourceQuestionId={fromQuestion} />;
}
