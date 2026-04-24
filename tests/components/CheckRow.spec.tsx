import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CheckResult } from "@/lib/schema";
import { CheckRow } from "@/components/CheckRow";

function makeCheck(over: Partial<CheckResult> = {}): CheckResult {
  return {
    status: "fail",
    message: "robots.txt not found",
    evidence: [
      {
        action: "fetch",
        label: "GET /robots.txt",
        request: { url: "https://example.com/robots.txt", method: "GET" },
        response: {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "text/html" },
        },
        finding: { outcome: "negative", summary: "404" },
      },
      {
        action: "conclude",
        label: "Conclusion",
        finding: { outcome: "negative", summary: "robots.txt not found" },
      },
    ],
    durationMs: 12,
    ...over,
  };
}

function expandTrigger(): HTMLElement {
  // The outer trigger is the first button with aria-expanded.
  const buttons = screen.getAllByRole("button");
  const trigger = buttons.find((b) => b.hasAttribute("aria-expanded"));
  if (trigger === undefined) throw new Error("No expand trigger found");
  return trigger;
}

describe("<CheckRow />", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  it("renders a pass status icon", () => {
    render(
      <CheckRow checkId="robotsTxt" check={makeCheck({ status: "pass" })} />,
    );
    expect(screen.getByTestId("status-icon-pass")).toBeInTheDocument();
  });

  it("renders a fail status icon", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);
    expect(screen.getByTestId("status-icon-fail")).toBeInTheDocument();
  });

  it("renders a neutral status icon", () => {
    render(
      <CheckRow checkId="ap2" check={makeCheck({ status: "neutral" })} />,
    );
    expect(screen.getByTestId("status-icon-neutral")).toBeInTheDocument();
  });

  it("shows a human-readable check name", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);
    // CheckRow uses "robots.txt" as the label for `robotsTxt`.
    expect(screen.getAllByText(/robots\.txt/i).length).toBeGreaterThan(0);
  });

  it("renders the check message", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);
    expect(screen.getByText(/robots\.txt not found/i)).toBeInTheDocument();
  });

  it("expanded failed check defaults to Overview tab", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);

    fireEvent.click(expandTrigger());

    const overviewTab = screen.getByTestId("check-tab-overview");
    expect(overviewTab).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("check-panel-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("check-panel-audit")).toBeNull();
  });

  it("expanded passing check renders the evidence timeline directly (no tabs)", () => {
    render(
      <CheckRow checkId="robotsTxt" check={makeCheck({ status: "pass" })} />,
    );

    fireEvent.click(expandTrigger());

    expect(screen.getByTestId("check-panel-audit")).toBeInTheDocument();
    expect(screen.queryByTestId("check-tab-overview")).toBeNull();
    expect(screen.queryByTestId("check-tab-audit")).toBeNull();
  });

  it("expanded neutral check renders the evidence timeline directly (no tabs)", () => {
    render(<CheckRow checkId="ap2" check={makeCheck({ status: "neutral" })} />);

    fireEvent.click(expandTrigger());

    expect(screen.getByTestId("check-panel-audit")).toBeInTheDocument();
    expect(screen.queryByTestId("check-tab-overview")).toBeNull();
    expect(screen.queryByTestId("check-tab-audit")).toBeNull();
  });

  it("switches to Audit tab when clicked", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);

    fireEvent.click(expandTrigger());
    fireEvent.click(screen.getByTestId("check-tab-audit"));

    expect(screen.getByTestId("check-panel-audit")).toBeInTheDocument();
    expect(screen.queryByTestId("check-panel-overview")).toBeNull();
  });

  it("View audit details button switches to Audit tab", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);

    fireEvent.click(expandTrigger());
    fireEvent.click(
      screen.getByRole("button", { name: /view audit details/i }),
    );

    expect(screen.getByTestId("check-panel-audit")).toBeInTheDocument();
  });

  it("renders the CopyPromptButton in the Overview tab for failing checks", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);

    fireEvent.click(expandTrigger());

    expect(
      screen.getByRole("button", { name: /copy fix prompt|copy prompt/i }),
    ).toBeInTheDocument();
  });

  it("renders resource links from the prompt catalog specUrls", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);

    fireEvent.click(expandTrigger());

    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
  });

  it("collapsed trigger exposes aria-expanded=false initially", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);
    expect(expandTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses again when the trigger is clicked twice", () => {
    render(<CheckRow checkId="robotsTxt" check={makeCheck()} />);
    const trig = expandTrigger();
    fireEvent.click(trig);
    expect(trig).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trig);
    expect(trig).toHaveAttribute("aria-expanded", "false");
  });

  it("resets tab state when check.status changes from fail to pass", () => {
    const { rerender } = render(
      <CheckRow checkId="robotsTxt" check={makeCheck()} />,
    );

    // Expand and switch to the Audit tab in fail state.
    fireEvent.click(expandTrigger());
    fireEvent.click(screen.getByTestId("check-tab-audit"));
    expect(screen.getByTestId("check-panel-audit")).toBeInTheDocument();

    // Re-scan yields a passing check — the tab state should reset, and the
    // component should now render the timeline directly (no tab strip).
    rerender(
      <CheckRow checkId="robotsTxt" check={makeCheck({ status: "pass" })} />,
    );

    expect(screen.queryByTestId("check-tab-overview")).toBeNull();
    expect(screen.queryByTestId("check-tab-audit")).toBeNull();
    expect(screen.getByTestId("check-panel-audit")).toBeInTheDocument();
  });
});
