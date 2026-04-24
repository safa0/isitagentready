"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckId } from "@/lib/schema";
import { PROMPTS } from "@/lib/engine/prompts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Copies the per-check fix prompt to the clipboard.
 * Shows a "Copied!" confirmation for 2s after click, with a polite
 * aria-live region so assistive tech announces the change.
 */

interface CopyPromptButtonProps {
  readonly checkId: CheckId;
  readonly label?: string;
  readonly className?: string;
}

const COPIED_VISIBLE_MS = 2000;

function getPromptFor(checkId: CheckId): string {
  return PROMPTS[checkId].prompt;
}

export function CopyPromptButton({
  checkId,
  label,
  className,
}: CopyPromptButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    const prompt = getPromptFor(checkId);
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      // jsdom or insecure contexts may not expose clipboard; fail closed.
      return;
    }
    void clipboard
      .writeText(prompt)
      .then(() => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, COPIED_VISIBLE_MS);
      })
      .catch(() => {
        // Surface nothing to the UI — the user's browser blocked the write.
        // Caller can inspect `navigator.permissions` separately if needed.
      });
  }, [checkId]);

  const buttonLabel = label ?? "Copy fix prompt";

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
      >
        {copied ? "Copied!" : buttonLabel}
      </Button>
      <span
        data-testid="copy-live-region"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {copied ? "Prompt copied to clipboard" : ""}
      </span>
    </span>
  );
}
