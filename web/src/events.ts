import type { API, Page } from "./api";

// One subscription per project. Acknowledgement happens only after a full SSE page.
export function subscribe(api: API, project: string, changed: () => void) {
  const controller = new AbortController();
  let cursor = "",
    timer: ReturnType<typeof setTimeout>;
  async function connect() {
    try {
      const query = new URLSearchParams({
        project_id: project,
        ...(cursor ? { cursor } : {}),
      });
      const res = await fetch(`/api/v1/events?${query}`, {
        headers: {
          Authorization: `Bearer ${api.token}`,
          Accept: "text/event-stream",
        },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30000),
        ]),
      });
      if (res.status === 410 || res.status === 400) {
        cursor = "";
        changed();
        throw new Error("Cursor expired");
      }
      if (
        !res.ok ||
        !res.body ||
        !res.headers.get("Content-Type")?.includes("text/event-stream")
      )
        throw new Error("Event stream unavailable");
      const reader = res.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = message
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            const page = JSON.parse(data.slice(6)) as Page;
            cursor = page.next_cursor || cursor;
            if (page.items.length) changed();
          }
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(connect, 1000);
    } catch {
      if (!controller.signal.aborted) {
        changed();
        timer = setTimeout(connect, 10000);
      }
    }
  }
  void connect();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
