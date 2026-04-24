"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { CheckId, Profile } from "@/lib/schema";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The hero scan form: a URL input + an orange Scan button.
 *
 * Submits to POST /api/scan with the optional profile + enabledChecks,
 * then routes to /[hostname] on success so the results page renders
 * server-side with the same inputs.
 */

interface ScanFormProps {
  readonly prefilledUrl?: string;
  readonly profile?: Profile;
  readonly enabledChecks?: readonly CheckId[];
  /** Optional override for tests. */
  readonly onSubmitOverride?: (url: string) => void | Promise<void>;
}

const SCAN_TIMEOUT_MS = 25_000;

function hostnameFor(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.host;
  } catch {
    return null;
  }
}

function buildResultsPath(
  url: string,
  profile: Profile | undefined,
  enabledChecks: readonly CheckId[] | undefined,
): string | null {
  const host = hostnameFor(url);
  if (host === null) return null;
  const qs = new URLSearchParams();
  qs.set("url", url);
  if (profile !== undefined) qs.set("profile", profile);
  if (enabledChecks !== undefined && enabledChecks.length > 0) {
    qs.set("enabledChecks", enabledChecks.join(","));
  }
  return `/${host}?${qs.toString()}`;
}

export function ScanForm({
  prefilledUrl,
  profile,
  enabledChecks,
  onSubmitOverride,
}: ScanFormProps): React.JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState(prefilledUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (busy) return;
      setError(null);

      const target = url.trim();
      if (target.length === 0) return;

      if (onSubmitOverride !== undefined) {
        await onSubmitOverride(target);
        return;
      }

      setBusy(true);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
      try {
        const body: Record<string, unknown> = { url: target };
        if (profile !== undefined) body.profile = profile;
        if (enabledChecks !== undefined && enabledChecks.length > 0) {
          body.enabledChecks = enabledChecks;
        }
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          let message = `Scan failed (${res.status}).`;
          try {
            const data = (await res.json()) as { error?: string };
            if (typeof data.error === "string" && data.error.length > 0) {
              message = data.error;
            }
          } catch {
            // Body wasn't JSON — keep the generic message.
          }
          setError(message);
          return;
        }
        const dest = buildResultsPath(target, profile, enabledChecks);
        if (dest === null) {
          setError("Could not parse that URL.");
          return;
        }
        router.push(dest);
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError") {
          setError("Scan timed out. Please try again.");
        } else {
          setError("Scan failed. Check the URL and try again.");
        }
      } finally {
        clearTimeout(timer);
        setBusy(false);
      }
    },
    [busy, url, profile, enabledChecks, onSubmitOverride, router],
  );

  const errorId = "scan-form-error";

  return (
    <form
      className="flex w-full max-w-2xl flex-col gap-3"
      onSubmit={handleSubmit}
      noValidate={false}
    >
      <div className="flex w-full items-stretch gap-2">
        <input
          type="url"
          required
          placeholder="https://example.com"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.currentTarget.value)}
          aria-label="Website URL"
          aria-describedby={error !== null ? errorId : undefined}
          aria-invalid={error !== null ? true : undefined}
          className={cn(
            "min-w-0 flex-1 rounded-xl border-2 border-[#F6821F]/80 bg-background px-4 py-3 text-base",
            "text-foreground placeholder:text-muted-foreground",
            "outline-none transition focus-visible:border-[#F6821F] focus-visible:ring-4 focus-visible:ring-[#F6821F]/20",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        <Button
          type="submit"
          aria-busy={busy ? true : undefined}
          disabled={busy}
          className={cn(
            "shrink-0 rounded-xl bg-[#F6821F] px-6 py-3 text-base font-medium text-white shadow-sm",
            "hover:bg-[#E07719] focus-visible:ring-4 focus-visible:ring-[#F6821F]/30",
            "disabled:cursor-not-allowed disabled:opacity-70",
          )}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
              Scanning…
            </span>
          ) : (
            "Scan"
          )}
        </Button>
      </div>
      {error !== null ? (
        <p
          id={errorId}
          role="alert"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
