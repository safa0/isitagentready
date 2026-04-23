import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScoreGauge } from "@/components/ScoreGauge";

describe("<ScoreGauge />", () => {
  it("renders the score with a meter role and accessible attributes", () => {
    render(<ScoreGauge score={58} size="md" />);
    const meter = screen.getByRole("meter", { name: /score/i });
    expect(meter).toHaveAttribute("aria-valuenow", "58");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
  });

  it("shows the score number in the center", () => {
    render(<ScoreGauge score={42} size="md" />);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText(/score/i)).toBeInTheDocument();
  });

  it("clamps a score below 0 to 0", () => {
    render(<ScoreGauge score={-10} size="md" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("clamps a score above 100 to 100", () => {
    render(<ScoreGauge score={250} size="md" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("100")).toBeInTheDocument();
  });

  it("rounds a non-integer score", () => {
    render(<ScoreGauge score={73.6} size="md" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "74");
  });

  it("applies the red data-color when score < 40", () => {
    render(<ScoreGauge score={20} size="md" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-color", "red");
  });

  it("applies the orange data-color when score is 40-69", () => {
    render(<ScoreGauge score={55} size="md" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-color", "orange");
  });

  it("applies the green data-color when score >= 70", () => {
    render(<ScoreGauge score={90} size="md" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-color", "green");
  });

  it.each([
    ["sm", 80],
    ["md", 160],
    ["lg", 240],
  ] as const)("renders svg sized for size=%s (approx %d)", (size, expected) => {
    render(<ScoreGauge score={50} size={size} />);
    const meter = screen.getByRole("meter");
    const svg = meter.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe(String(expected));
    expect(svg?.getAttribute("height")).toBe(String(expected));
  });

  it("defaults to md size when size prop omitted", () => {
    render(<ScoreGauge score={50} />);
    const meter = screen.getByRole("meter");
    const svg = meter.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("160");
  });

  it("exposes the score via aria-label for screen readers", () => {
    render(<ScoreGauge score={58} />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-label") ?? "").toMatch(/58/);
  });
});
