import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScanForm } from "@/components/ScanForm";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe("<ScanForm />", () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a url input with an example placeholder and a Scan button", () => {
    render(<ScanForm />);
    const input = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "url");
    expect(input).toBeRequired();
    expect(
      screen.getByRole("button", { name: /^scan$/i }),
    ).toBeInTheDocument();
  });

  it("prefills the input when prefilledUrl is supplied", () => {
    render(<ScanForm prefilledUrl="https://example.org" />);
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("https://example.org");
  });

  it("submits the form and navigates to /[hostname] on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScanForm />);
    const input = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    await user.type(input, "https://example.com");
    await user.click(screen.getByRole("button", { name: /^scan$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/scan");
    expect(init.method).toBe("POST");
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.url).toBe("https://example.com");

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled();
    });
    const dest = pushMock.mock.calls[0]?.[0] as string;
    expect(dest).toMatch(/\/example\.com/);
  });

  it("shows an error message when the API returns a non-2xx response", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "Invalid URL" }),
      }),
    );

    render(<ScanForm />);
    await user.type(
      screen.getByPlaceholderText(/https:\/\/example\.com/i),
      "https://example.com",
    );
    await user.click(screen.getByRole("button", { name: /^scan$/i }));

    const error = await screen.findByRole("alert");
    expect(error.textContent ?? "").toMatch(/Invalid URL/i);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("shows an error when fetch throws (network/timeout)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    render(<ScanForm />);
    await user.type(
      screen.getByPlaceholderText(/https:\/\/example\.com/i),
      "https://example.com",
    );
    await user.click(screen.getByRole("button", { name: /^scan$/i }));

    const error = await screen.findByRole("alert");
    expect(error.textContent ?? "").toMatch(/scan|network|failed/i);
  });

  it("disables the input and shows aria-busy while the scan is in flight", async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void = () => undefined;
    const pending = new Promise((r) => {
      resolve = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        pending.then(() => ({
          ok: true,
          status: 200,
          json: async () => ({ url: "https://example.com" }),
        })),
      ),
    );

    render(<ScanForm />);
    const input = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    await user.type(input, "https://example.com");
    const button = screen.getByRole("button", { name: /^scan$/i });
    await user.click(button);

    await waitFor(() => {
      expect(button).toHaveAttribute("aria-busy", "true");
    });
    expect(input).toBeDisabled();

    resolve(null);
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled();
    });
  });

  it("passes profile + enabledChecks to the API when provided", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ScanForm
        profile="content"
        enabledChecks={["robotsTxt", "sitemap"]}
      />,
    );
    await user.type(
      screen.getByPlaceholderText(/https:\/\/example\.com/i),
      "https://example.com",
    );
    await user.click(screen.getByRole("button", { name: /^scan$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.profile).toBe("content");
    expect(body.enabledChecks).toEqual(["robotsTxt", "sitemap"]);
  });
});
