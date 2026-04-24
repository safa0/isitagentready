import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomizePanel } from "@/components/CustomizePanel";
import type { CheckId, Profile } from "@/lib/schema";
import { DEFAULT_ENABLED_CHECKS } from "@/lib/engine/scoring";

function buildChecks(): Record<CheckId, boolean> {
  const all = [
    "robotsTxt",
    "sitemap",
    "linkHeaders",
    "markdownNegotiation",
    "robotsTxtAiRules",
    "contentSignals",
    "webBotAuth",
    "apiCatalog",
    "oauthDiscovery",
    "oauthProtectedResource",
    "mcpServerCard",
    "a2aAgentCard",
    "agentSkills",
    "webMcp",
    "x402",
    "mpp",
    "ucp",
    "acp",
    "ap2",
  ] as const satisfies readonly CheckId[];
  const out = {} as Record<CheckId, boolean>;
  for (const id of all) out[id] = DEFAULT_ENABLED_CHECKS.includes(id);
  return out;
}

describe("<CustomizePanel />", () => {
  it("renders a collapsed trigger by default", () => {
    const checks = buildChecks();
    render(
      <CustomizePanel
        profile="all"
        onProfileChange={() => undefined}
        checks={checks}
        onCheckChange={() => undefined}
        isCommerce={true}
      />,
    );
    expect(
      screen.getByRole("button", { name: /customize scan/i }),
    ).toBeInTheDocument();
  });

  it("expands to reveal profile radio + check groups when clicked", async () => {
    const user = userEvent.setup();
    const checks = buildChecks();
    render(
      <CustomizePanel
        profile="all"
        onProfileChange={() => undefined}
        checks={checks}
        onCheckChange={() => undefined}
        isCommerce={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: /customize scan/i }));
    expect(await screen.findByText(/site type/i)).toBeInTheDocument();
    expect(screen.getByText(/discoverability/i)).toBeInTheDocument();
    expect(screen.getByText(/content accessibility/i)).toBeInTheDocument();
    expect(screen.getByText(/bot access control/i)).toBeInTheDocument();
    expect(screen.getByText(/commerce/i)).toBeInTheDocument();
  });

  it("emits onProfileChange when a different profile is selected", async () => {
    const user = userEvent.setup();
    const onProfileChange = vi.fn<(p: Profile) => void>();
    const checks = buildChecks();
    render(
      <CustomizePanel
        profile="all"
        onProfileChange={onProfileChange}
        checks={checks}
        onCheckChange={() => undefined}
        isCommerce={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: /customize scan/i }));
    await user.click(
      screen.getByRole("radio", { name: /content site/i }),
    );
    expect(onProfileChange).toHaveBeenCalledWith("content");
  });

  it("emits onCheckChange with the full map when a checkbox toggles", async () => {
    const user = userEvent.setup();
    const onCheckChange = vi.fn<(c: Record<CheckId, boolean>) => void>();
    const checks = buildChecks();
    render(
      <CustomizePanel
        profile="all"
        onProfileChange={() => undefined}
        checks={checks}
        onCheckChange={onCheckChange}
        isCommerce={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: /customize scan/i }));
    const robotsCheckbox = screen.getByRole("checkbox", { name: /robots\.txt$/i });
    await user.click(robotsCheckbox);
    expect(onCheckChange).toHaveBeenCalled();
    const last = onCheckChange.mock.calls.at(-1)?.[0];
    expect(last?.robotsTxt).toBe(false);
  });

  it("hides the commerce group when profile is content", async () => {
    const user = userEvent.setup();
    const checks = buildChecks();
    render(
      <CustomizePanel
        profile="content"
        onProfileChange={() => undefined}
        checks={checks}
        onCheckChange={() => undefined}
        isCommerce={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: /customize scan/i }));
    expect(screen.queryByText(/^commerce$/i)).not.toBeInTheDocument();
  });

  it("defaults a2aAgentCard to unchecked and disabled-looking", async () => {
    const user = userEvent.setup();
    const checks = buildChecks();
    render(
      <CustomizePanel
        profile="all"
        onProfileChange={() => undefined}
        checks={checks}
        onCheckChange={() => undefined}
        isCommerce={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: /customize scan/i }));
    const a2a = screen.getByRole("checkbox", { name: /a2a agent card/i });
    expect(a2a).not.toBeChecked();
  });
});
