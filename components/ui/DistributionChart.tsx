"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";

export interface BucketDataPoint {
  bucket: string;
  count: number;
  percentage?: number;
}

export interface DistributionChartProps {
  title?: string;
  data: BucketDataPoint[];
  color?: string;
  height?: number;
  unit?: string;
  emptyText?: string;
}

export function DistributionChart({
  title,
  data,
  color = "#059669", // emerald-600
  height = 180,
  unit = "个",
  emptyText = "暂无分布数据",
}: DistributionChartProps) {
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!data || data.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-400">
        {emptyText}
      </div>
    );
  }

  // SSR fallback placeholder to prevent hydration layout shift
  if (!isMounted) {
    return <div style={{ height }} className="w-full animate-pulse rounded-lg bg-slate-50" />;
  }

  return (
    <div className="w-full">
      {title && <h4 className="mb-2 text-xs font-semibold text-slate-700">{title}</h4>}
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 11, fill: "#64748b" }}
              axisLine={{ stroke: "#cbd5e1" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: "rgba(241, 245, 249, 0.6)" }}
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const item = payload[0].payload as BucketDataPoint;
                  return (
                    <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-md text-xs">
                      <p className="font-semibold text-slate-900">{item.bucket}</p>
                      <p className="text-emerald-700 mt-0.5">
                        数量: <span className="font-bold">{item.count}</span> {unit}
                        {item.percentage !== undefined && (
                          <span className="text-slate-500 ml-1.5">({item.percentage}%)</span>
                        )}
                      </p>
                    </div>
                  );
                }
                return null;
              }}
            />
            <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]}>
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
