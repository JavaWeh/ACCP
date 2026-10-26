import { useI18n } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "./ui";

/** Shareable same-origin URL: origin + pathname + search + hash. */
export function currentPageUrl(
  loc: Pick<Location, "origin" | "pathname" | "search" | "hash"> = location,
): string {
  return `${loc.origin}${loc.pathname}${loc.search}${loc.hash}`;
}

export function CopyLink({
  ariaLabel,
}: {
  /** Stable accessible name (kept while showing “Copied”). */
  ariaLabel?: string;
}) {
  const { translate } = useI18n();
  const [copied, setCopied] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackInput = useRef<HTMLInputElement>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  useEffect(() => {
    if (!fallback) return;
    const input = fallbackInput.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [fallback]);

  async function copy() {
    const value = currentPageUrl();
    clearTimeout(resetTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard");
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setAnnounce(translate("链接已复制到剪贴板"));
      resetTimer.current = setTimeout(() => {
        setCopied(false);
        setAnnounce("");
      }, 2000);
    } catch {
      setFallback(value);
    }
  }

  const name = ariaLabel ?? translate("复制链接");

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="min-w-28"
        aria-label={name}
        onPress={() => {
          void copy();
        }}
      >
        {copied ? `✓ ${translate("已复制")}` : translate("复制链接")}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {fallback !== null && (
        <Modal title={translate("复制链接")} close={() => setFallback(null)}>
          <p className="mb-3 text-sm text-slate-600">
            {translate("无法自动复制，请按 Ctrl+C 复制链接")}
          </p>
          <input
            ref={fallbackInput}
            readOnly
            aria-label={translate("复制链接")}
            className="w-full rounded-lg border border-slate-400 bg-white px-3 py-2 font-mono text-sm"
            value={fallback}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Modal>
      )}
    </>
  );
}
