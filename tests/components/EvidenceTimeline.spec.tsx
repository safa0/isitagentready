import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EvidenceStep } from "@/lib/schema";
import { EvidenceTimeline } from "@/components/EvidenceTimeline";

const step = (over: Partial<EvidenceStep> = {}): EvidenceStep => ({
  action: "fetch",
  label: "GET /robots.txt",
  request: {
    url: "https://example.com/robots.txt",
    method: "GET",
    headers: { accept: "text/plain" },
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/plain" },
    bodyPreview: "User-agent: *\nAllow: /",
  },
  finding: { outcome: "positive", summary: "Received valid robots.txt" },
  ...over,
});

describe("<EvidenceTimeline />", () => {
  it("renders all steps in order", () => {
    const evidence: EvidenceStep[] = [
      step({ label: "GET /robots.txt" }),
      step({
        action: "parse",
        label: "Validate structure",
        request: undefined,
        response: undefined,
        finding: { outcome: "positive", summary: "OK" },
      }),
      step({
        action: "conclude",
        label: "Conclusion",
        request: undefined,
        response: undefined,
        finding: {
          outcome: "positive",
          summary: "robots.txt exists with valid format",
        },
      }),
    ];
    render(<EvidenceTimeline evidence={evidence} durationMs={42} />);
    const labels = screen
      .getAllByTestId("evidence-step-label")
      .map((el) => el.textContent);
    expect(labels).toEqual([
      "GET /robots.txt",
      "Validate structure",
      "Conclusion",
    ]);
  });

  it("shows response status code when available", () => {
    render(
      <EvidenceTimeline
        evidence={[step({ response: { ...step().response!, status: 404 } })]}
        durationMs={10}
      />,
    );
    expect(screen.getByText("404")).toBeInTheDocument();
  });

  it("omits the status badge when no response is present", () => {
    const s = step({ request: undefined, response: undefined });
    render(<EvidenceTimeline evidence={[s]} durationMs={10} />);
    expect(screen.queryByTestId("evidence-status")).toBeNull();
  });

  it("renders finding summary text", () => {
    render(
      <EvidenceTimeline
        evidence={[
          step({
            finding: {
              outcome: "negative",
              summary: "Server returned 404 -- not found",
            },
          }),
        ]}
        durationMs={5}
      />,
    );
    expect(
      screen.getByText(/Server returned 404 -- not found/i),
    ).toBeInTheDocument();
  });

  it("renders a body preview when present", () => {
    render(
      <EvidenceTimeline
        evidence={[
          step({
            response: {
              ...step().response!,
              bodyPreview: "User-agent: *\nAllow: /",
            },
          }),
        ]}
        durationMs={7}
      />,
    );
    expect(screen.getByText(/User-agent: \*/)).toBeInTheDocument();
  });

  it("shows the total durationMs in the footer", () => {
    render(
      <EvidenceTimeline
        evidence={[step(), step({ label: "again" })]}
        durationMs={123}
      />,
    );
    expect(screen.getByTestId("evidence-total-duration")).toHaveTextContent(
      "123",
    );
  });

  it("renders each of the five action icon variants", () => {
    const actions = [
      "fetch",
      "parse",
      "validate",
      "navigate",
      "conclude",
    ] as const;
    render(
      <EvidenceTimeline
        evidence={actions.map((a) =>
          step({
            action: a,
            label: `${a} step`,
            request: undefined,
            response: undefined,
            finding: { outcome: "neutral", summary: `${a} summary` },
          }),
        )}
        durationMs={0}
      />,
    );
    for (const a of actions) {
      expect(screen.getByTestId(`evidence-icon-${a}`)).toBeInTheDocument();
    }
  });

  it("shows a placeholder when evidence is empty", () => {
    render(<EvidenceTimeline evidence={[]} durationMs={0} />);
    expect(screen.getByText(/no evidence/i)).toBeInTheDocument();
  });

  it("renders request and response header tables when present", () => {
    render(
      <EvidenceTimeline
        evidence={[
          step({
            request: {
              url: "https://example.com/r",
              method: "GET",
              headers: { "x-test": "hi" },
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "text/plain" },
            },
          }),
        ]}
        durationMs={1}
      />,
    );
    expect(screen.getByText(/x-test/i)).toBeInTheDocument();
    expect(screen.getByText(/content-type/i)).toBeInTheDocument();
  });
});
