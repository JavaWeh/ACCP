import { useCallback, useEffect, useRef, useState } from "react";
import type { API, Page } from "../api";

/** One in-app notification (F3 / US-20). Mirrors the server response item. */
export type NotificationItem = {
  id: string;
  type: string;
  project_id: string;
  project_name: string;
  title: string;
  occurred_at: string;
  deep_link: string;
  read: boolean;
};

/**
 * Badge text for the unread count (O-W10): zero shows no number (the caller
 * hides the badge entirely), and anything at or past a hundred caps at "99+".
 */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  if (count >= 100) return "99+";
  return String(count);
}

/** The console's poll cadence (F1 D-2): the badge refreshes on the same beat. */
const SUMMARY_POLL_MS = 10000;

/**
 * Notification-centre state (F3). The unread badge is a *polled* summary, not a
 * realtime push: it refreshes on the console's 10s cadence so it never pretends
 * to be live (F1 ConnectionStatus honesty). The list is fetched on demand when
 * the panel opens and paginates with the server cursor. Read state is written
 * through to the server (durable, per-user) and mirrored optimistically so a
 * deep-link click clears the badge immediately.
 */
export function useNotifications({
  api,
  enabled,
}: {
  api: API;
  enabled: boolean;
}) {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const loaded = useRef(false);

  const refreshCount = useCallback(async () => {
    try {
      const summary = await api.call<{ unread_count: number }>(
        "/me/notifications/summary",
      );
      setCount(summary.unread_count);
    } catch {
      // A failed summary poll leaves the last known count; the next tick retries.
    }
  }, [api]);

  // Poll the unread summary while enabled so the badge stays roughly fresh
  // without a realtime channel (cross-project, so the per-project SSE cannot
  // cover it — see MyWork's identical poll rationale).
  useEffect(() => {
    if (!enabled) return;
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), SUMMARY_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refreshCount]);

  const load = useCallback(
    async (opts: { unread: boolean; cursor?: string }) => {
      setLoading(true);
      setError(undefined);
      try {
        const query = new URLSearchParams({ limit: "20" });
        if (opts.unread) query.set("unread", "true");
        if (opts.cursor) query.set("cursor", opts.cursor);
        const page = await api.call<Page<NotificationItem>>(
          `/me/notifications?${query.toString()}`,
        );
        setItems((prev) =>
          opts.cursor ? [...prev, ...page.items] : page.items,
        );
        setCursor(page.next_cursor ?? null);
        loaded.current = true;
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  // Fresh page from the top under the current filter (used when the panel opens
  // and whenever the unread chip toggles).
  const refreshList = useCallback(() => {
    void load({ unread: unreadOnly });
  }, [load, unreadOnly]);

  const loadMore = useCallback(() => {
    if (cursor) void load({ unread: unreadOnly, cursor });
  }, [cursor, load, unreadOnly]);

  const toggleUnread = useCallback(() => {
    setUnreadOnly((prev) => {
      const next = !prev;
      void load({ unread: next });
      return next;
    });
  }, [load]);

  const markRead = useCallback(
    async (id: string) => {
      const target = items.find((item) => item.id === id);
      if (!target || target.read) return;
      // Optimistic: clear the row and drop the badge by one immediately; the
      // write-through makes it durable.
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, read: true } : item)),
      );
      setCount((prev) => Math.max(0, prev - 1));
      try {
        await api.call(`/me/notifications/${encodeURIComponent(id)}/read`, {});
      } catch {
        void refreshCount();
      }
    },
    [api, items, refreshCount],
  );

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((item) => ({ ...item, read: true })));
    setCount(0);
    try {
      await api.call<{ unread_count: number }>(
        "/me/notifications/read-all",
        {},
      );
    } catch {
      void refreshCount();
    }
  }, [api, refreshCount]);

  return {
    count,
    items,
    hasMore: cursor !== null,
    loading,
    error,
    loaded: loaded.current,
    unreadOnly,
    refreshCount,
    refreshList,
    loadMore,
    toggleUnread,
    markRead,
    markAllRead,
  };
}
