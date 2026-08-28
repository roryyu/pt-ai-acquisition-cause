/**
 * 品牌 Logo 图标
 * 由多支箭头从四周汇聚到中心点，体现"归因"——多源数据汇聚、定位核心结论的产品意象。
 */
export function LogoIcon({
  className,
  size = 24,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 中心汇聚点 */}
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      {/* 上箭头 */}
      <path d="M12 4v7M9 8l3-4 3 4" />
      {/* 下箭头 */}
      <path d="M12 20v-7M9 16l3 4 3-4" />
      {/* 左箭头 */}
      <path d="M4 12h7M8 9l-4 3 4 3" />
      {/* 右箭头 */}
      <path d="M20 12h-7M16 9l4 3-4 3" />
    </svg>
  );
}
