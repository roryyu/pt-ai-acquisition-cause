"use client";

/**
 * 洞察画布详情页入口（轻包装）
 * tldraw 体积大且依赖浏览器 API，静态导入会在路由切换时一次性下载/求值
 * 十余 MB 的 JS，阻塞主线程造成「卡住」观感；此处改为 next/dynamic
 * 懒加载（ssr: false），导航时先展示占位，画布代码后台加载。
 */
import dynamic from "next/dynamic";

const InsightsDetailEditor = dynamic(
  () => import("./canvas-editor").then((m) => m.InsightsDetailEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-24" role="status">
        <span
          className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          style={{ color: "var(--purple)" }}
          aria-hidden
        />
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          画布加载中...
        </span>
      </div>
    ),
  },
);

export function InsightsDetailClient({
  docId,
  initialImport,
  initialCharts,
}: {
  docId: string;
  /** 深链导入参数：{sourceType}:{sourceId}，由编辑器挂载后自动消费 */
  initialImport?: string;
  /** 深链图表下标参数：逗号分隔（如 "0,2"），一图一卡导入 */
  initialCharts?: string;
}) {
  return (
    <InsightsDetailEditor
      docId={docId}
      initialImport={initialImport}
      initialCharts={initialCharts}
    />
  );
}
