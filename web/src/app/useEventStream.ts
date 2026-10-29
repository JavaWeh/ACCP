import { useEffect, useRef } from "react";
import type { API } from "../api";

/** Four-state console connection indicator (see ui-p0 §3.1). */
export type ConnectionState =
  "live" | "reconnecting" | "polling" | "auth_expired";

export type SseFrame = { event: string; data: string; id: string };

/**
 * Split a streamed buffer into complete SSE frames (separated by a blank line),
 * returning any trailing partial frame so it can be prepended to the next chunk.
 */
export function splitFrames(buffer: string): {
  frames: string[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames: string[] = [];
  let index: number;
  let rest = normalized;
  while ((index = rest.indexOf("\n\n")) !== -1) {
    frames.push(rest.slice(0, index));
    rest = rest.slice(index + 2);
  }
  return { frames, rest };
}

/** Parse one SSE frame into its event name, joined data, and last id. */
export function parseFrame(raw: string): SseFrame {
  let event = "message";
  let id = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }
  return { event, data: dataLines.join("\n"), id };
}

function pageHasItems(data: string): boolean {
  try {
    const page = JSON.parse(data) as { items?: unknown };
    return Array.isArray(page.items) && page.items.length > 0;
  } catch {
    return false;
  }
}

const MAX_BACKOFF = 30000;
// After this many consecutive failures we stop promising "reconnecting" and
// settle on the steady-state polling fallback (but keep probing for recovery).
const POLLING_THRESHOLD = 5;

/**
 * Subscribe to the current project's SSE feed with `fetch` streaming so the
 * `Authorization` header can be sent (native EventSource cannot — see
 * f1f2-impl §0.1). The stream is bounded (~24s server-side): a clean end is a
 * normal lifecycle event and reconnects immediately while staying `live`.
 * Errors back off with jitter; a 401 stops and surfaces `auth_expired`; a 503
 * (signing key unset) settles on `polling` without hammering the endpoint.
 *
 * SSE only nudges an early refresh (D-2): `useProjectData` keeps its own 10s
 * poll, so a missed event is at worst 10s stale.
 */
export function useEventStream({
  api,
  projectID,
  enabled,
  onEvents,
  onStatus,
}: {
  api: API;
  projectID: string;
  enabled: boolean;
  onEvents: () => void;
  onStatus: (status: ConnectionState) => void;
}) {
  const onEventsRef = useRef(onEvents);
  const onStatusRef = useRef(onStatus);
  onEventsRef.current = onEvents;
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!enabled || !projectID || !api.token) {
      onStatusRef.current("polling");
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    let cursor = "";
    let failures = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let notifyTimer: ReturnType<typeof setTimeout> | undefined;

    const setStatus = (status: ConnectionState) => onStatusRef.current(status);

    // Debounce refreshes: the server pushes a page every ~2s, but one nudge per
    // burst is enough since the incremental refresh is idempotent.
    const notify = () => {
      if (notifyTimer) return;
      notifyTimer = setTimeout(() => {
        notifyTimer = undefined;
        onEventsRef.current();
      }, 500);
    };

    const backoff = () => {
      const ceiling = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(failures, 5));
      return ceiling / 2 + Math.random() * (ceiling / 2);
    };

    const schedule = (delay: number) => {
      if (stopped) return;
      // Hidden tabs reconnect lazily to avoid a background reconnect storm.
      if (document.visibilityState === "hidden" && delay < MAX_BACKOFF)
        delay = MAX_BACKOFF;
      reconnectTimer = setTimeout(connect, delay);
    };

    async function connect() {
      reconnectTimer = undefined;
      if (stopped) return;
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const query = `project_id=${encodeURIComponent(projectID)}${cursorParam}`;
      try {
        const res = await fetch(`/api/v1/events?${query}`, {
          headers: {
            Authorization: `Bearer ${api.token}`,
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });
        if (res.status === 401) {
          // Let the existing OIDC expiry flow (via the 10s poll's api.onExpired)
          // drive logout; just stop the reconnect loop and show the state.
          setStatus("auth_expired");
          stopped = true;
          return;
        }
        if (res.status === 503) {
          // Signing key unset: realtime is unavailable in this deployment.
          setStatus("polling");
          stopped = true;
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`events stream ${res.status}`);
        }
        failures = 0;
        setStatus("live");
        const started = Date.now();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let serverClosed = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const split = splitFrames(buffer);
          buffer = split.rest;
          for (const raw of split.frames) {
            const frame = parseFrame(raw);
            if (frame.event === "accp.closed") {
              // Reauthenticate/reconcile or expired cursor: drop the cursor and
              // resubscribe at the current tail, then reconcile via a refresh.
              cursor = "";
              serverClosed = true;
              notify();
            } else if (frame.event === "accp.events") {
              if (frame.id) cursor = frame.id;
              if (pageHasItems(frame.data)) notify();
            }
          }
        }
        if (serverClosed) throw new Error("stream closed by server");
        // Clean end of a bounded stream: reconnect immediately, stay live.
        // Guard against a tight loop if the stream ends near-instantly.
        if (Date.now() - started < 1000) {
          failures += 1;
          if (failures >= POLLING_THRESHOLD) setStatus("polling");
          schedule(backoff());
        } else {
          schedule(0);
        }
      } catch {
        if (stopped || controller.signal.aborted) return;
        failures += 1;
        setStatus(failures >= POLLING_THRESHOLD ? "polling" : "reconnecting");
        schedule(backoff());
      }
    }

    const onVisibility = () => {
      // Returning to the tab: bring a pending reconnect forward.
      if (document.visibilityState === "visible" && reconnectTimer) {
        clearTimeout(reconnectTimer);
        schedule(0);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (notifyTimer) clearTimeout(notifyTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, projectID, enabled]);
}
