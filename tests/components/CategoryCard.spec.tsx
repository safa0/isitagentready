import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryCard } from "@/components/CategoryCard";

describe("<CategoryCard />", () => {
  it("renders a human-readable label for each category id", () => {
    const cases = [
      ["discoverability", /discoverability/i],
      ["contentAccessibility", /content/i],
      ["botAccessControl", /bot/i],
      ["discovery", /discovery/i],
      ["commerce", /commerce/i],
    ] as const;
    for (const [id, pattern] of cases) {
      const { unmount } = render(
        <CategoryCard category={id} score={50} passes={1} fails={1} />,
      );
      expect(screen.getByText(pattern)).toBeInTheDocument();
      unmount();
    }
  });

  it("embeds a ScoreGauge showing the score", () => {
    render(
      <CategoryCard
        category="discoverability"
        score={67}
        passes={2}
        fails={1}
      />,
    );
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "67");
  });

  it("shows pass and fail counts", () => {
    render(
      <CategoryCard
        category="discovery"
        score={30}
        passes={2}
        fails={5}
      />,
    );
    const passPill = screen.getByTestId("category-passes");
    const failPill = screen.getByTestId("category-fails");
    expect(passPill).toHaveTextContent("2");
    expect(failPill).toHaveTextContent("5");
  });

  it("renders zero counts without crashing", () => {
    render(
      <CategoryCard
        category="commerce"
        score={0}
        passes={0}
        fails={0}
      />,
    );
    expect(screen.getByTestId("category-passes")).toHaveTextContent("0");
    expect(screen.getByTestId("category-fails")).toHaveTextContent("0");
  });
});
