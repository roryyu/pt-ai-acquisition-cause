import type { NextConfig } from "next";

/**
 * 安全响应头（design.md 12.4 安全默认：响应附加安全头）
 * 跨站请求验证与 Origin 检查将在 API 层迭代中实现
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Prisma 7 客户端运行时（含 query compiler WASM）不参与打包，作为服务端外部依赖加载
  // duck-duck-scrape / @extractus/article-extractor（linkedom DOM 实现）同样外置，避免打包异常
  serverExternalPackages: ["@prisma/client", "duck-duck-scrape", "@extractus/article-extractor"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
