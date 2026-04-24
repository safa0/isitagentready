"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Tri-state theme toggle (system / light / dark).
 *
 * - Reads `localStorage["theme"]` on mount.
 * - When the mode is `system`, falls back to `prefers-color-scheme`.
 * - Writes/removes the `dark` class on `document.documentElement`.
 * - Renders a placeholder until mounted so SSR and hydration match.
 */

type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "theme";
const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

function prefersDark(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  return mq.matches;
}

function applyMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const shouldBeDark = mode === "dark" || (mode === "system" && prefersDark());
  if (shouldBeDark) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

function nextMode(current: ThemeMode): ThemeMode {
  const idx = MODES.indexOf(current);
  const nextIdx = (idx + 1) % MODES.length;
  return MODES[nextIdx] ?? "system";
}

function labelFor(mode: ThemeMode): string {
  if (mode === "light") return "Light";
  if (mode === "dark") return "Dark";
  return "System";
}

function IconFor({ mode }: { readonly mode: ThemeMode }): React.JSX.Element {
  // Simple hand-drawn glyph so we don't pull in another icon for one button.
  if (mode === "light") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="3"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
        <path
          d="M13 9.5A5 5 0 017.5 3a5 5 0 104.9 6.3.4.4 0 00-.4-.3z"
          fill="currentColor"
        />
      </svg>
    );
  }
  // System: half-filled circle.
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="5.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M8 2.5v11a5.5 5.5 0 000-11z" fill="currentColor" />
    </svg>
  );
}

export function ThemeToggle(): React.JSX.Element {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<ThemeMode>("system");

  useEffect(() => {
    const initial = readStoredMode();
    setMode(initial);
    applyMode(initial);
    setMounted(true);
  }, []);

  const cycle = useCallback(() => {
    setMode((current) => {
      const next = nextMode(current);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
      applyMode(next);
      return next;
    });
  }, []);

  const label = `Theme: ${labelFor(mode)}`;

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-full border border-border bg-background text-foreground",
        "transition hover:border-[#F6821F]/60",
        !mounted && "opacity-0",
      )}
    >
      <IconFor mode={mode} />
    </button>
  );
}
