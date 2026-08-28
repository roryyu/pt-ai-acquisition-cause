/**
 * 路由切换过渡占位（Next.js loading.tsx）
 * 点击侧边菜单后立即展示该反馈（Suspense 流式），
 * 避免目标路由客户端 JS 下载/求值期间页面「卡住」无响应。
 */
export default function DashboardLoading() {
  return (
    <div className="flex items-center justify-center py-24" role="status">
      <span
        className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        style={{ color: "var(--purple)" }}
        aria-hidden
      />
      <span className="text-sm" style={{ color: "var(--muted)" }}>
        页面加载中...
      </span>
    </div>
  );
}
