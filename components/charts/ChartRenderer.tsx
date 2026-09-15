"use client";

import { useCallback, useRef } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { Download } from "lucide-react";
import type { ChartSpec } from "@/lib/agent-events";

/**
 * 图表渲染器：Agent 产出的 ChartSpec → Recharts 图表
 * 支持 bar / line / area / pie / radar / composed，含数值格式化与 PNG 导出
 */

const PALETTE = ["#523b8f", "#8b6fd0", "#c9a8f0", "#176e53", "#875600", "#9b3141"];

/** 与 globals.css body 字体栈保持一致，保证导出图内文字与页面观感相同 */
const FONT_STACK =
  '"Avenir Next", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif';

const SVG_NS = "http://www.w3.org/2000/svg";

/** 数值格式化（千分位 / 百分比 / 万元 / 紧凑） */
function formatValue(value: number, format?: ChartSpec["valueFormat"]): string {
  if (!Number.isFinite(value)) return String(value);
  switch (format) {
    case "percent": {
      const pct = value <= 1 ? value * 100 : value;
      return `${pct.toFixed(pct >= 100 ? 0 : 1)}%`;
    }
    case "wan":
      return `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
    case "compact":
      if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
      if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
      return value.toLocaleString("zh-CN");
    default:
      return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
}

function toNumber(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

export function ChartRenderer({ spec, height = 300 }: { spec: ChartSpec; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  /** 导出 PNG：把「标题 + 图表主体 + 图例」合成为自包含 SVG 后栅格化下载 */
  const exportPng = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Recharts 的图例/提示是 HTML 浮层，图例色块本身也是 svg，且在 DOM 中先于图表主体出现，
    // 因此不能 querySelector("svg") 取第一个；图表主体是排除浮层后面积最大的 surface。
    const surfaces = [...container.querySelectorAll<SVGSVGElement>("svg.recharts-surface")].filter(
      (s) => !s.closest(".recharts-legend-wrapper, .recharts-tooltip-wrapper"),
    );
    const svg = surfaces.sort(
      (a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height -
        a.getBoundingClientRect().width * a.getBoundingClientRect().height,
    )[0];
    if (!svg) return;

    const svgRect = svg.getBoundingClientRect();
    const chartW = Math.round(svgRect.width);
    const chartH = Math.round(svgRect.height);
    const PAD = 20;
    const titleH = 28;
    const width = chartW + PAD * 2;
    const height = titleH + chartH + PAD * 2;
    const scale = 2;

    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("xmlns", SVG_NS);
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    root.setAttribute("font-family", FONT_STACK);

    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", String(width));
    bg.setAttribute("height", String(height));
    bg.setAttribute("fill", "#fffefa");
    root.appendChild(bg);

    // 标题行：主标题 + 维度/单位说明，与卡片 figcaption 一致
    const subtitle =
      [spec.xLabel, spec.yLabel].filter(Boolean).join(" × ") + (spec.unit ? `（${spec.unit}）` : "");
    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("x", String(PAD));
    title.setAttribute("y", String(PAD + 15));
    title.setAttribute("font-size", "15");
    title.setAttribute("font-weight", "600");
    title.setAttribute("fill", "#211a36");
    title.textContent = spec.title;
    root.appendChild(title);
    if (subtitle) {
      const measure = document.createElement("canvas").getContext("2d");
      if (measure) {
        measure.font = `600 15px ${FONT_STACK}`;
        const sub = document.createElementNS(SVG_NS, "text");
        sub.setAttribute("x", String(PAD + measure.measureText(spec.title).width + 8));
        sub.setAttribute("y", String(PAD + 16));
        sub.setAttribute("font-size", "12");
        sub.setAttribute("fill", "#706b79");
        sub.textContent = subtitle;
        root.appendChild(sub);
      }
    }

    // 图表主体：克隆为嵌套 svg 放置，保留其自身坐标系；
    // 原 style 的 width/height:100% 会相对父级解析导致拉伸，必须移除。
    const chart = svg.cloneNode(true) as SVGSVGElement;
    chart.removeAttribute("style");
    chart.setAttribute("x", String(PAD));
    chart.setAttribute("y", String(PAD + titleH));
    root.appendChild(chart);

    // 图例：按屏幕上的实际位置描回图表底部（色块图标 + 文本）
    const legend = container.querySelector<HTMLElement>(".recharts-legend-wrapper");
    if (legend) {
      const legendRect = legend.getBoundingClientRect();
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute(
        "transform",
        `translate(${PAD + legendRect.x - svgRect.x}, ${PAD + titleH + legendRect.y - svgRect.y})`,
      );
      legend.querySelectorAll("li").forEach((li) => {
        const icon = li.querySelector("svg");
        if (icon) {
          const iconRect = icon.getBoundingClientRect();
          const clone = icon.cloneNode(true) as SVGSVGElement;
          clone.removeAttribute("style");
          clone.setAttribute("x", String(iconRect.x - legendRect.x));
          clone.setAttribute("y", String(iconRect.y - legendRect.y));
          group.appendChild(clone);
        }
        const label = li.querySelector(".recharts-legend-item-text");
        if (label) {
          const labelRect = label.getBoundingClientRect();
          const text = document.createElementNS(SVG_NS, "text");
          text.setAttribute("x", String(labelRect.x - legendRect.x));
          text.setAttribute("y", String(labelRect.y - legendRect.y + labelRect.height / 2));
          text.setAttribute("dominant-baseline", "central");
          text.setAttribute("font-size", "12");
          text.setAttribute("fill", getComputedStyle(label).color);
          text.textContent = label.textContent ?? "";
          group.appendChild(text);
        }
      });
      root.appendChild(group);
    }

    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(root);
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fffefa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const link = document.createElement("a");
      link.download = `${spec.title.replace(/[\\/:*?"<>|]/g, "_")}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    };
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgStr)))}`;
  }, [spec.title, spec.xLabel, spec.yLabel, spec.unit]);

  const data = spec.data.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const key of spec.yKeys) copy[key] = toNumber(row[key]);
    copy[spec.xKey] = row[spec.xKey];
    return copy as Record<string, string | number>;
  });

  const axisProps = {
    tick: { fontSize: 11, fill: "#706b79" },
    stroke: "#ddd9e2",
  };

  const tooltipFormatter = (value: unknown, name: string) => [
    `${formatValue(toNumber(value), spec.valueFormat)}${spec.unit && !spec.valueFormat ? ` ${spec.unit}` : ""}`,
    name,
  ] as [string, string];

  return (
    <figure
      className="rounded-[var(--radius-sm)] border p-4"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <figcaption className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {spec.title}
          {(spec.xLabel || spec.yLabel) && (
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--muted)" }}>
              {[spec.xLabel, spec.yLabel].filter(Boolean).join(" × ")}
              {spec.unit ? `（${spec.unit}）` : ""}
            </span>
          )}
        </figcaption>
        <button
          onClick={exportPng}
          className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-black/[0.03]"
          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          title="导出 PNG"
        >
          <Download size={12} /> PNG
        </button>
      </div>

      <div ref={containerRef} style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(spec, data, axisProps)}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function renderChart(
  spec: ChartSpec,
  data: Record<string, string | number>[],
  axisProps: { tick: { fontSize: number; fill: string }; stroke: string },
) {
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="#eee9f2" vertical={false} />;
  const xAxis = (
    <XAxis
      dataKey={spec.xKey}
      tick={axisProps.tick}
      stroke={axisProps.stroke}
      interval="preserveStartEnd"
      angle={data.length > 12 ? -30 : 0}
      textAnchor={data.length > 12 ? "end" : "middle"}
      height={data.length > 12 ? 50 : 30}
    />
  );
  const yAxis = (
    <YAxis
      tick={axisProps.tick}
      stroke={axisProps.stroke}
      width={64}
      tickFormatter={(v: number) => formatValue(v, spec.valueFormat === "percent" ? "percent" : "compact")}
    />
  );
  const tooltip = (
    <Tooltip
      formatter={(value: unknown, name: unknown) =>
        [
          `${formatValue(toNumber(value), spec.valueFormat)}${spec.unit && !spec.valueFormat ? ` ${spec.unit}` : ""}`,
          String(name ?? ""),
        ] as [string, string]
      }
      contentStyle={{
        borderRadius: 10,
        border: "1px solid var(--line)",
        background: "var(--surface)",
        fontSize: 12,
      }}
    />
  );

  switch (spec.type) {
    case "bar":
      return (
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {grid}{xAxis}{yAxis}{tooltip}<Legend wrapperStyle={{ fontSize: 12 }} />
          {spec.yKeys.map((key, i) => (
            <Bar key={key} dataKey={key} fill={PALETTE[i % PALETTE.length]} radius={[4, 4, 0, 0]} maxBarSize={48} />
          ))}
        </BarChart>
      );
    case "line":
      return (
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {grid}{xAxis}{yAxis}{tooltip}<Legend wrapperStyle={{ fontSize: 12 }} />
          {spec.yKeys.map((key, i) => (
            <Line
              key={key} dataKey={key} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2}
              dot={data.length <= 30 ? { r: 2.5 } : false} activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {grid}{xAxis}{yAxis}{tooltip}<Legend wrapperStyle={{ fontSize: 12 }} />
          {spec.yKeys.map((key, i) => (
            <Area
              key={key} dataKey={key} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]}
              fillOpacity={0.18} strokeWidth={2}
            />
          ))}
        </AreaChart>
      );
    case "pie": {
      const key = spec.yKeys[0] ?? "value";
      return (
        <PieChart>
          {tooltip}<Legend wrapperStyle={{ fontSize: 12 }} />
          <Pie
            data={data} dataKey={key} nameKey={spec.xKey}
            cx="50%" cy="50%" innerRadius="42%" outerRadius="72%" paddingAngle={2}
            label={(entry: { name?: unknown; percent?: number }) =>
              `${entry.name ?? ""} ${((entry.percent ?? 0) * 100).toFixed(0)}%`
            }
            labelLine={false}
          >
            {data.map((row, i) => (
              <Cell key={String(row[spec.xKey])} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      );
    }
    case "radar":
      return (
        <RadarChart data={data} outerRadius="70%">
          <PolarGrid stroke="#eee9f2" />
          <PolarAngleAxis dataKey={spec.xKey} tick={{ fontSize: 11, fill: "#706b79" }} />
          <PolarRadiusAxis tick={{ fontSize: 10, fill: "#706b79" }} stroke="#ddd9e2" />
          {tooltip}<Legend wrapperStyle={{ fontSize: 12 }} />
          {spec.yKeys.map((key, i) => (
            <Radar
              key={key} dataKey={key} stroke={PALETTE[i % PALETTE.length]}
              fill={PALETTE[i % PALETTE.length]} fillOpacity={0.25}
            />
          ))}
        </RadarChart>
      );
    case "composed":
    default:
      return (
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {grid}{xAxis}{yAxis}{tooltip}<Legend wrapperStyle={{ fontSize: 12 }} />
          {spec.yKeys.map((key, i) =>
            i === 0 ? (
              <Bar key={key} dataKey={key} fill={PALETTE[0]} radius={[4, 4, 0, 0]} maxBarSize={48} />
            ) : (
              <Line key={key} dataKey={key} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
            ),
          )}
        </ComposedChart>
      );
  }
}
