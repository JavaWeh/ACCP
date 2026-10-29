import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import type { API } from "../api";
import { badgeText, useNotifications } from "./useNotifications";
import { NotificationPanel } from "./NotificationPanel";

/**
 * Top-bar notification bell (F3 / US-20), mounted immediately after the
 * connection status so the two cross-project cues sit together. The badge
 * shows the polled unread count (no number at zero, "99+" past a hundred —
 * O-W10) and never implies realtime delivery. Opening the bell loads the
 * panel; Escape and an outside click close it; a deep-link click closes it,
 * marks the item read, and navigates.
 */
export function NotificationBell({
  api,
  onOpen,
}: {
  api: API;
  onOpen: (href: string) => void;
}) {
  const { translate } = useI18n();
  const [open, setOpen] = useState(false);
  const notif = useNotifications({ api, enabled: true });
  const container = useRef<HTMLDivElement>(null);

  // Load the first page when the panel opens; refresh it on each reopen so a
  // stale list never lingers behind a fresh badge count.
  useEffect(() => {
    if (open) notif.refreshList();
    // notif.refreshList is stable for a given filter; intentionally keyed on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (
        container.current &&
        !container.current.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const badge = badgeText(notif.count);

  return (
    <div ref={container} className="relative shrink-0">
      <button
        type="button"
        aria-label={translate("通知（{count} 条未读）", { count: notif.count })}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="relative flex min-h-8 items-center rounded-lg border border-slate-200 px-2.5 py-1 text-slate-700 outline-offset-2 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-600"
      >
        <Icon name="bell" className="size-4" />
        {badge && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] leading-4 font-semibold text-white"
          >
            {badge}
          </span>
        )}
      </button>
      {open && (
        <NotificationPanel
          notif={notif}
          onOpen={(href) => {
            setOpen(false);
            onOpen(href);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
