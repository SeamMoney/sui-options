import { memo } from "react";

function scoreColor(score: number): string {
  if (score < 15) return "#7f1d1d";
  if (score < 30) return "#ef4444";
  if (score < 45) return "#f87171";
  if (score < 55) return "#fbbf24";
  if (score < 75) return "#60a5fa";
  return "#00C853";
}

const CircularGauge = memo(function CircularGauge({
  score,
  size = 48,
}: {
  score: number | null;
  size?: number;
}) {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return (
      <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="font-mono text-[11px] text-white/30">—</span>
      </div>
    );
  }

  const radius = size * 0.417;
  const stroke = size * 0.0625;
  const center = size / 2;
  const normalized = Math.min(100, Math.max(0, score));
  const dashArray = 2 * Math.PI * radius;
  const dashOffset = dashArray - (normalized / 100) * dashArray;
  const color = scoreColor(normalized);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={dashArray}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span
        className="absolute font-mono font-semibold"
        style={{ fontSize: size * 0.25, color }}
      >
        {Math.round(score)}
      </span>
    </div>
  );
});

export default CircularGauge;
