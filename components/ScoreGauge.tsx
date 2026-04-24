"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Animated circular score gauge (speedometer-style).
 *
 * - Sweeps a ~270° arc from 0 → 100.
 * - Red <40, orange 40–69, green >=70 (exposed via `data-color` for tests).
 * - Animates stroke-dashoffset on mount via a CSS transition (~600ms).
 * - Accessible: `role="meter"` with `aria-valuenow/min/max` and `aria-label`.
 */

export type ScoreGaugeSize = "sm" | "md" | "lg";

interface ScoreGaugeProps {
  readonly score: number;
  readonly size?: ScoreGaugeSize;
  readonly label?: string;
}

const SIZE_PX: Readonly<Record<ScoreGaugeSize, number>> = {
  sm: 80,
  md: 160,
  lg: 240,
};

// Sweep covers 270° (3/4 of the circle), starting from the bottom-left
// and ending at the bottom-right. This matches Cloudflare's reference UI.
const SWEEP_DEG = 270;

function clampScore(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return Math.round(raw);
}

function colorFor(score: number): "red" | "orange" | "green" {
  if (score < 40) return "red";
  if (score < 70) return "orange";
  return "green";
}

const STROKE_CLASS: Readonly<Record<"red" | "orange" | "green", string>> = {
  red: "stroke-red-500",
  orange: "stroke-[#F6821F]",
  green: "stroke-green-500",
};

const TEXT_CLASS: Readonly<Record<"red" | "orange" | "green", string>> = {
  red: "text-red-500",
  orange: "text-[#F6821F]",
  green: "text-green-500",
};

const NUMBER_TEXT_SIZE: Readonly<Record<ScoreGaugeSize, string>> = {
  sm: "text-xl",
  md: "text-4xl",
  lg: "text-6xl",
};

const LABEL_TEXT_SIZE: Readonly<Record<ScoreGaugeSize, string>> = {
  sm: "text-[10px]",
  md: "text-xs",
  lg: "text-sm",
};

export function ScoreGauge({
  score,
  size = "md",
  label,
}: ScoreGaugeProps): React.JSX.Element {
  const clamped = clampScore(score);
  const color = colorFor(clamped);
  const px = SIZE_PX[size];

  // SVG geometry: draw a circle with a wide stroke, then rotate and mask
  // to expose only the 270° sweep. Circumference = 2·π·r.
  const strokeWidth = size === "sm" ? 8 : size === "md" ? 12 : 16;
  const radius = px / 2 - strokeWidth;
  const circumference = 2 * Math.PI * radius;
  // The visible arc is 3/4 of the circle.
  const arcLength = (circumference * SWEEP_DEG) / 360;
  const gapLength = circumference - arcLength;

  // Animate from 0 → target on mount.
  const [animated, setAnimated] = useState(0);
  useEffect(() => {
    // Delay one frame so the initial paint renders offset=arcLength (0%),
    // then transitions to the real value.
    const raf = requestAnimationFrame(() => setAnimated(clamped));
    return () => cancelAnimationFrame(raf);
  }, [clamped]);

  const progress = animated / 100;
  const dashOffset = arcLength - arcLength * progress;

  // Rotate so the arc starts at the bottom-left. 270° sweep means the start
  // point is at (90° + 135°) = 225° from the 12-o'clock baseline. With
  // `transform="rotate(135 cx cy)"` on the SVG group we get the expected
  // speedometer look.
  const rotate = 135;
  const center = px / 2;
  const ariaLabel = label ?? `Agent readiness score ${clamped} out of 100`;

  return (
    <div
      role="meter"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
      data-color={color}
      className={cn(
        "relative inline-flex flex-col items-center justify-center",
      )}
      style={{ width: px, height: px }}
    >
      <svg
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        aria-hidden="true"
      >
        <g transform={`rotate(${rotate} ${center} ${center})`}>
          {/* Track */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            className="stroke-muted"
            strokeDasharray={`${arcLength} ${gapLength}`}
          />
          {/* Progress */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            className={cn(
              STROKE_CLASS[color],
              "transition-[stroke-dashoffset] duration-700 ease-out",
            )}
            strokeDasharray={`${arcLength} ${gapLength}`}
            strokeDashoffset={dashOffset}
          />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "font-semibold tabular-nums tracking-tight",
            NUMBER_TEXT_SIZE[size],
            TEXT_CLASS[color],
          )}
        >
          {clamped}
        </span>
        <span
          className={cn(
            "mt-1 uppercase tracking-wider text-muted-foreground",
            LABEL_TEXT_SIZE[size],
          )}
        >
          Score
        </span>
      </div>
    </div>
  );
}
