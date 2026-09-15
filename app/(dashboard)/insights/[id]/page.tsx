import type { Metadata } from "next";
import { InsightsDetailClient } from "./client";

export const metadata: Metadata = { title: "洞察画布" };

/**
 * ?import={sourceType}:{sourceId} 深链：问答/研究页"加入画布"跳转后自动导入，
 * 编辑器挂载后创建实时形状与绑定，完成后清除参数。
 * ?charts=0,2：弹窗勾选的图表下标（逗号分隔），按「一图一卡」创建多张卡片。
 */
export default async function InsightDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ import?: string; charts?: string }>;
}) {
  const { id } = await params;
  const { import: importParam, charts: chartsParam } = await searchParams;
  return (
    <InsightsDetailClient
      docId={id}
      initialImport={importParam}
      initialCharts={chartsParam}
    />
  );
}
