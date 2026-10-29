// Pure/unit coverage for the F3 notification centre. The badge formatter
// (O-W10: no number at zero, "99+" past a hundred) and the type→label mapping
// are extracted as module-level pure functions and tested directly, mirroring
// the MyWork spec. The disclosure behaviour (open/Esc/outside-click), the
// polled badge, optimistic mark-read, and deep-link navigation need React + a
// live api.call and are residual managed-server e2e.
import { expect, test } from "@playwright/test";
import { badgeText } from "../src/app/useNotifications";
import {
  NOTIFICATION_LABELS,
  notificationLabelKey,
} from "../src/app/NotificationPanel";

test("badgeText hides zero and caps at 99+ (O-W10)", () => {
  expect(badgeText(0)).toBe("");
  expect(badgeText(-3)).toBe("");
  expect(badgeText(1)).toBe("1");
  expect(badgeText(42)).toBe("42");
  expect(badgeText(99)).toBe("99");
  expect(badgeText(100)).toBe("99+");
  expect(badgeText(1000)).toBe("99+");
});

test("notificationLabelKey maps every known type to a distinct label", () => {
  for (const type of [
    "TASK_ASSIGNED",
    "REVIEW_REQUIRED",
    "APPROVAL_PENDING",
    "TASK_BLOCKED",
    "COMMENT_MENTION",
  ]) {
    expect(notificationLabelKey(type)).toBe(NOTIFICATION_LABELS[type]);
  }
});

test("notificationLabelKey falls back to the neutral heading for unknown types", () => {
  expect(notificationLabelKey("SOMETHING_NEW")).toBe("通知");
  expect(notificationLabelKey("")).toBe("通知");
});
