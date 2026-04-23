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
    // Fake only setTimeout/clearTimeout so `vi.advanceTimersByTime` drives the
    // 2s revert, while real microtasks still flush — clipboard.writeText()'s
    // `.then(...)` needs the real Promise queue to resolve.
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

  it("no-op when navigator.clipboard is undefined", async () => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;

    render(<CopyPromptButton checkId="robotsTxt" />);

    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent(/copy fix prompt/i);

    fireEvent.click(btn);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(btn).toHaveTextContent(/copy fix prompt/i);
    expect(btn).not.toHaveTextContent(/copied/i);
  });

  it("second click while Copied clears prior timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    render(<CopyPromptButton checkId="sitemap" />);
    const btn = screen.getByRole("button");

    fireEvent.click(btn);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(btn).toHaveTextContent(/copied/i);

    // Advance partway, then click again — this should reset the 2s window.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(btn);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(btn).toHaveTextContent(/copied/i);

    // Advance by just over the original 2s from the first click — should still
    // be Copied because the second click scheduled a fresh 2s window.
    await act(async () => {
      vi.advanceTimersByTime(1001);
    });
    expect(btn).toHaveTextContent(/copied/i);
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
