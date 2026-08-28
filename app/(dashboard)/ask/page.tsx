import type { Metadata } from "next";
import { AskClient } from "./client";

export const metadata: Metadata = { title: "任务问答" };

/**
 * ?q={questionId} 深链：画布实时卡片"打开来源"回跳时自动加载对应问答详情
 */
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <AskClient initialQuestionId={q} />;
}
