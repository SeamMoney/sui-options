import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { type MarketSnapshot } from "@/fixtures/markets";
import { formatPriceCents } from "@/lib/format";

interface ChartPlaceholderProps {
  market: MarketSnapshot;
}

function syntheticSeries(market: MarketSnapshot, n = 180) {
  const out: { t: number; price: number }[] = [];
  let p = market.underlyingPrice;
  let seed = market.id.charCodeAt(2) || 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const noise = ((seed % 200) - 100) / 10000;
    p = Math.max(1, Math.round(p * (1 + noise)));
    out.push({ t: i, price: p });
  }
  out[out.length - 1] = { t: n - 1, price: market.underlyingPrice };
  return out;
}

export function ChartPlaceholder({ market }: ChartPlaceholderProps) {
  const data = useMemo(() => syntheticSeries(market), [market]);
  const min = Math.min(...data.map((d) => d.price), market.barrier) * 0.997;
  const max = Math.max(...data.map((d) => d.price), market.barrier) * 1.003;

  return (
    <div className="flex-1 min-h-0 bg-card">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 12, right: 56, bottom: 12, left: 12 }}
        >
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fafafa" stopOpacity={0.16} />
              <stop offset="100%" stopColor="#fafafa" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="2 4"
            stroke="#1f1f1f"
            vertical={false}
          />
          <XAxis
            dataKey="t"
            tick={{ fill: "#525252", fontSize: 9, fontFamily: "Bai Jamjuree" }}
            axisLine={{ stroke: "#1f1f1f" }}
            tickLine={false}
            minTickGap={60}
          />
          <YAxis
            domain={[min, max]}
            orientation="right"
            tick={{ fill: "#525252", fontSize: 9, fontFamily: "Bai Jamjuree" }}
            axisLine={{ stroke: "#1f1f1f" }}
            tickLine={false}
            tickFormatter={(v) => v.toLocaleString()}
            width={56}
          />
          <Tooltip
            contentStyle={{
              background: "#161616",
              border: "1px solid #262626",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: "Bai Jamjuree",
              padding: "4px 8px",
            }}
            labelStyle={{ color: "#a1a1aa" }}
            formatter={(v) => [
              typeof v === "number" ? v.toLocaleString() : String(v),
              "",
            ]}
          />
          <ReferenceLine
            y={market.barrier}
            stroke="#f59e0b"
            strokeWidth={1}
            strokeDasharray="3 3"
            label={{
              value: `${formatPriceCents(market.barrier)} →`,
              position: "right",
              fill: "#f59e0b",
              fontSize: 10,
              fontFamily: "Bai Jamjuree",
            }}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke="#fafafa"
            strokeWidth={1.25}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
