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

  /** 导出 PNG：SVG → canvas → 下载 */
  const exportPng = useCallback(() => {
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svg);
    const canvas = document.createElement("canvas");
    const rect = svg.getBoundingClientRect();
    canvas.width = Math.max(rect.width, 600) * 2;
    canvas.height = Math.max(rect.height, 300) * 2;
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
  }, [spec.title]);

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
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
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
