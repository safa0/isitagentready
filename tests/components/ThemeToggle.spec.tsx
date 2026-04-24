import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "@/components/ThemeToggle";

describe("<ThemeToggle />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("renders a button with an accessible label", () => {
    render(<ThemeToggle />);
    expect(
      screen.getByRole("button", { name: /theme/i }),
    ).toBeInTheDocument();
  });

  it("reads the saved theme from localStorage on mount and applies .dark", () => {
    window.localStorage.setItem("theme", "dark");
    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("cycles through system -> light -> dark on click", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /theme/i });

    // Initial state (system) — no explicit class change asserted
    await user.click(button);
    expect(window.localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(button);
    expect(window.localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(button);
    expect(window.localStorage.getItem("theme")).toBe("system");
  });

  it("falls back to prefers-color-scheme when no stored preference exists", () => {
    const mm = vi.fn((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
    vi.stubGlobal("matchMedia", mm);

    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    vi.unstubAllGlobals();
  });
});
