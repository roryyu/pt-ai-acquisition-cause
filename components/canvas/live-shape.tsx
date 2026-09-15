"use client";

/**
 * 洞察画布自定义形状：LiveContentShape（实时内容卡片）
 * 由 CanvasBinding 驱动，承载数据分析图表 / 问答结论 / 深度研究报告；
 * 源任务运行中显示"更新中"徽标，完成后显示最近更新时间。
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  type TLBaseShape,
} from "tldraw";
import { ChartRenderer } from "@/components/charts/ChartRenderer";
import { MarkdownView } from "@/components/agent/MarkdownView";
import { isSourceDeleted, isSourceRunning, sourceStatusLabel, type LivePayload } from "@/lib/canvas/types";

/** 实时内容形状 props（w/h 为 BaseBoxShapeUtil 约定的宽高字段） */
export interface TLLiveContentShapeProps {
  w: number;
  h: number;
  /** 关联绑定 id（删形状时级联清理绑定；轮询刷新时按此回填 payload） */
  bindingId: string;
  /** 来源类型（空串表示未绑定） */
  sourceType: "" | "question" | "research" | "metric";
  /** 来源 id（question_xxx / task_xxx，供溯源回跳） */
  sourceId: string;
  /** 最新内容负载 */
  payload: LivePayload | null;
  /** 源任务状态（running 类 → 徽标"更新中"，deleted → "源已删除"） */
  sourceStatus: string;
  /** 最近更新时间（ISO） */
  updatedAt: string;
  /**
   * 仅展示 payload.charts 中该下标的图表（问答弹窗勾选后「一图一卡」导入）；
   * -1 表示不限定，展示来源全部图表（下标越界时同样回退为全部）。
   */
  chartIndex: number;
}

// 模块增强：将自定义形状注册进 tldraw 全局形状表，TLShape 联合类型方可识别
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "live-content": TLLiveContentShapeProps;
  }
}

/** 实时内容形状类型（tldraw store 记录形态） */
export type TLLiveContentShape = TLBaseShape<"live-content", TLLiveContentShapeProps>;

/** 相对时间展示（刚刚 / x 分钟前 / x 小时前 / 日期） */
function formatUpdatedAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`;
  return d.toLocaleDateString("zh-CN");
}

/** 溯源链接：question → /ask?q={id} 自动加载详情；research → 研究页（参数化留待后续） */
function sourceHref(sourceType: string, sourceId: string): string | null {
  if (!sourceId) return null;
  if (sourceType === "question") return `/ask?q=${sourceId}`;
  if (sourceType === "research") return "/research";
  return null;
}

export class LiveContentShapeUtil extends BaseBoxShapeUtil<TLLiveContentShape> {
  static override type = "live-content" as const;

  override getDefaultProps(): TLLiveContentShape["props"] {
    return {
      w: 460,
      h: 340,
      bindingId: "",
      sourceType: "",
      sourceId: "",
      payload: null,
      sourceStatus: "unknown",
      updatedAt: "",
      chartIndex: -1,
    };
  }

  override component(shape: TLLiveContentShape) {
    const { payload, sourceStatus, updatedAt } = shape.props;
    // 旧 snapshot 中的形状可能缺少新字段，兼容空值（等同于未绑定来源）
    const sourceType = shape.props.sourceType ?? "";
    const sourceId = shape.props.sourceId ?? "";
    const chartIndex = shape.props.chartIndex ?? -1;
    const running = isSourceRunning(sourceStatus);
    const deleted = isSourceDeleted(sourceStatus);
    const href = sourceHref(sourceType, sourceId);

    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          display: "flex",
          flexDirection: "column",
          borderRadius: 12,
          border: "1px solid #e7e2d8",
          background: "#fffefa",
          boxShadow: "0 2px 12px rgb(28 18 48 / 8%)",
          overflow: "hidden",
          fontFamily: "inherit",
        }}
      >
        {/* 卡片头：标题 + 实时徽标 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid #efe9dd",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 13,
              fontWeight: 600,
              color: "#241b38",
            }}
          >
            {payload?.title ?? "实时内容"}
          </span>
          {/* 溯源回跳：打开来源问答/研究（阻止冒泡避免触发 tldraw 拖拽） */}
          {href && (
            <a
              href={href}
              title="打开来源"
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                fontSize: 10,
                color: "#7a52c9",
                textDecoration: "none",
                padding: "2px 4px",
                borderRadius: 6,
              }}
            >
              打开来源 ↗
            </a>
          )}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              borderRadius: 999,
              padding: "2px 9px",
              fontSize: 10,
              fontWeight: 600,
              background: deleted ? "#ece9f1" : running ? "#f6ead2" : "#e9f4ee",
              color: deleted ? "#6f6880" : running ? "#875600" : "#176e53",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: deleted ? "#9a93a8" : running ? "#c98a1b" : "#2fa27a",
                animation: running ? "tl-pulse 1.2s ease-in-out infinite" : undefined,
              }}
            />
            {deleted
              ? sourceStatusLabel(sourceStatus)
              : running
                ? `更新中 · ${sourceStatusLabel(sourceStatus)}`
                : `实时 · ${formatUpdatedAt(updatedAt) || sourceStatusLabel(sourceStatus)}`}
          </span>
        </div>

        {/* 卡片体：按 payload 类型渲染 */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 12 }}>
          <LiveCardBody
            payload={payload}
            width={shape.props.w - 24}
            height={shape.props.h - 76}
            running={running}
            chartIndex={chartIndex}
          />
        </div>
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: TLLiveContentShape) {
    // 选中态描边：与卡片同尺寸的圆角矩形
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }
}

/** 从 Markdown 正文提取纯文本摘要（剥离格式与引用角标，供图表卡片底部小字展示） */
function plainSnippet(md: string): string {
  return md
    .replace(/\[\^?\d+\]/g, "")
    .replace(/[#*`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 卡片体：图表 / 文本 / 研究三种负载 */
function LiveCardBody({
  payload,
  width,
  height,
  running,
  chartIndex,
}: {
  payload: LivePayload | null;
  width: number;
  height: number;
  running: boolean;
  /** 仅展示该下标的图表；-1 / 越界时展示全部 */
  chartIndex: number;
}) {
  // 占位：无内容或源运行中
  if (!payload || (running && !payload.text && !payload.charts?.length)) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "#8a8296",
          fontSize: 12,
        }}
      >
        {running ? (
          <>
            <span style={{ fontSize: 20 }}>⏳</span>
            数据生成中，稍后自动更新...
          </>
        ) : (
          <>
            <span style={{ fontSize: 20 }}>📭</span>
            暂无内容，等待数据源产出
          </>
        )}
      </div>
    );
  }

  // 图表类：一图一卡（指定 chartIndex）时单图撑满主体，
  // 否则全部图表纵向排列、超出卡片高度时内部滚动
  if (payload.kind === "chart" && payload.charts && payload.charts.length > 0) {
    const pickedChart = chartIndex >= 0 ? payload.charts[chartIndex] : undefined;
    // 下标越界（源图表变动）时回退为展示全部
    const charts = pickedChart ? [pickedChart] : payload.charts;
    // 单图卡片不再重复底部摘要（同一来源多张卡会重复展示同一段结论）
    const showSnippet = !pickedChart;
    // ChartRenderer 外框（标题栏+mb-3+内边距+边框）固定占约 72px，底部摘要区占 56px，
    // 两者都须从图表区高度中扣除，否则图表向下溢出与摘要文字重叠
    const singleHeight = Math.max(120, height - 72 - (payload.text && showSnippet ? 56 : 0));
    const snippet = payload.text && showSnippet ? plainSnippet(payload.text) : "";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, height: "100%" }}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: charts.length > 1 ? "auto" : "hidden",
            overflowX: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
          // 滚轮留给卡片内图表列表，避免触发 tldraw 画布缩放/平移
          onWheel={(e) => e.stopPropagation()}
        >
          {charts.map((chart, i) => (
            <div key={`${chart.type}-${chart.title}-${i}`} style={{ flexShrink: 0 }}>
              <ChartRenderer spec={chart} height={charts.length === 1 ? singleHeight : 210} />
            </div>
          ))}
        </div>
        {snippet && (
          <div
            style={{
              flexShrink: 0,
              maxHeight: 48,
              overflow: "hidden",
              fontSize: 11,
              lineHeight: "16px",
              color: "#5d5470",
            }}
          >
            {snippet.slice(0, 120)}
            {snippet.length > 120 ? "…" : ""}
          </div>
        )}
      </div>
    );
  }

  // 文本 / 研究类：Markdown 正文 + 引用角标
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 6 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", width }}>
        <MarkdownView content={payload.text ?? ""} />
      </div>
      {payload.citations && payload.citations.length > 0 && (
        <div style={{ flexShrink: 0, fontSize: 10, color: "#8a8296" }}>
          引用 {payload.citations.length} 篇来源
        </div>
      )}
    </div>
  );
}
