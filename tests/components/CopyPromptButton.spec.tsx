import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { CopyPromptButton } from "@/components/CopyPromptButton";
import { PROMPTS } from "@/lib/engine/prompts";

function installClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

describe("<CopyPromptButton />", () => {
  beforeEach(() => {
    installClipboard(vi.fn().mockResolvedValue(undefined));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the per-check prompt to the clipboard when clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    render(<CopyPromptButton checkId="robotsTxt" />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith(PROMPTS.robotsTxt.prompt);
  });

  it("shows a Copied! state after click and reverts after 2s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    render(<CopyPromptButton checkId="sitemap" />);

    const btn = screen.getByRole("button");
    expect(btn).not.toHaveTextContent(/copied/i);

    fireEvent.click(btn);
    // Let the resolved clipboard promise flush, then assert the Copied! state.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(btn).toHaveTextContent(/copied/i);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(btn).not.toHaveTextContent(/copied/i);
  });

  it("announces the copied state via aria-live region", async () => {
    render(<CopyPromptButton checkId="linkHeaders" />);

    const live = screen.getByTestId("copy-live-region");
    expect(live).toHaveAttribute("aria-live", "polite");

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(live.textContent ?? "").toMatch(/copied/i);
    });
  });

  it("gracefully handles a clipboard rejection without throwing", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    installClipboard(writeText);

    render(<CopyPromptButton checkId="robotsTxt" />);

    fireEvent.click(screen.getByRole("button"));
    // Allow the rejected promise to settle without the component crashing.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});
