interface SparkProps {
  values: number[];
  width?: number;
  height?: number;
  positive?: boolean;
  strokeWidth?: number;
  className?: string;
}

/**
 * Tiny inline sparkline. Auto-detects up/down by first vs last point if `positive`
 * is not provided. SVG, no dependencies.
 */
export function Spark({
  values,
  width = 64,
  height = 20,
  positive,
  strokeWidth = 1.5,
  className = "",
}: SparkProps) {
  if (!values || values.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden="true">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.2}
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => `${i * stepX},${height - ((v - min) / range) * height}`)
    .join(" ");

  const isUp = positive ?? values[values.length - 1] >= values[0];
  const stroke = isUp ? "rgb(var(--up))" : "rgb(var(--down))";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
