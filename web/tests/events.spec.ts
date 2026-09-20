import { test, expect } from "@playwright/test";

test("one event subscription acknowledges pages and refreshes during disconnection", async ({
  page,
}) => {
  const cursors: string[] = [];
  let connections = 0;
  await page.route("**/api/v1/events?**", async (route) => {
    connections++;
    cursors.push(
      new URL(route.request().url()).searchParams.get("cursor") || "",
    );
    if (connections === 1)
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'event: accp.events\ndata: {"items":[{"id":"event_one"}],"next_cursor":"cursor_one"}\n\n',
      });
    return route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const { API } = await import("/src/api.ts"),
      { subscribe } = await import("/src/events.ts");
    const state = window as unknown as {
      notifications: number;
      stop: () => void;
    };
    state.notifications = 0;
    state.stop = subscribe(
      new API("synthetic", () => {}),
      "project_one",
      () => state.notifications++,
    );
  });
  await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
  expect(cursors.slice(0, 2)).toEqual(["", "cursor_one"]);
  expect(
    await page.evaluate(
      () => (window as unknown as { notifications: number }).notifications,
    ),
  ).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => (window as unknown as { stop: () => void }).stop());
});
