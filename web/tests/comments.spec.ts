// Pure/unit coverage for the F11 task comments block, mirroring the audit and
// notifications specs: the chronological sort (render order, O-W14), the
// @mention detection/filter/insert/resolve helpers (O-W15) and the send-error
// classification (invalid-mention vs. generic failure) are extracted as
// module-level pure functions and tested directly. The full React behaviours —
// the draft (incl. @mentions) being retained after a failed send, auto-scroll
// to the newest comment, and the picker opening on "@" — are residual
// managed-server e2e, consistent with the other specs.
import { expect, test } from "@playwright/test";
import {
  applyMention,
  detectMention,
  filterMentionCandidates,
  resolveMentions,
  sendErrorKey,
  sortComments,
  type CommentItem,
} from "../src/tasks/TaskComments";
import { ApiError, type Membership } from "../src/api";

function member(id: string, name: string, active = true): Membership {
  return {
    id,
    organization_id: "org",
    project_id: "p",
    display_name: name,
    roles: ["MEMBER"],
    active,
    version: 1,
  };
}

function comment(id: string, createdAt: string): CommentItem {
  return {
    id,
    task_id: "t1",
    author_user_id: "u1",
    author_name: "User",
    body: "hi",
    mentions: [],
    edited: false,
    deleted: false,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

test("sortComments renders oldest-first, stable by id", () => {
  const sorted = sortComments([
    comment("c3", "2026-10-29T03:00:00Z"),
    comment("c1", "2026-10-29T01:00:00Z"),
    comment("c2", "2026-10-29T02:00:00Z"),
    comment("c2b", "2026-10-29T02:00:00Z"),
  ]);
  expect(sorted.map((c) => c.id)).toEqual(["c1", "c2", "c2b", "c3"]);
});

test("detectMention opens only on an active @token", () => {
  expect(detectMention("hello @bo", 9)).toEqual({ start: 6, query: "bo" });
  // "@" at the very start is valid.
  expect(detectMention("@al", 3)).toEqual({ start: 0, query: "al" });
  // An "@" mid-word (not after whitespace) is not a mention.
  expect(detectMention("email@host", 10)).toBeNull();
  // A whitespace after the token closes it.
  expect(detectMention("hi @bob ", 8)).toBeNull();
  // No "@" at all.
  expect(detectMention("just text", 9)).toBeNull();
});

test("filterMentionCandidates matches name/id and excludes inactive", () => {
  const members = [
    member("user_alice", "Alice"),
    member("user_bob", "Bob"),
    member("user_gone", "Ghost", false),
  ];
  expect(filterMentionCandidates(members, "al").map((m) => m.id)).toEqual([
    "user_alice",
  ]);
  // Matches by id too.
  expect(filterMentionCandidates(members, "bob").map((m) => m.id)).toEqual([
    "user_bob",
  ]);
  // Empty query lists every active member; the inactive one is excluded.
  expect(filterMentionCandidates(members, "").map((m) => m.id)).toEqual([
    "user_alice",
    "user_bob",
  ]);
});

test("applyMention replaces the token with @name and advances the caret", () => {
  const { text, caret } = applyMention(
    "ping @bo rest",
    5,
    8,
    member("user_bob", "Bob"),
  );
  expect(text).toBe("ping @Bob  rest");
  expect(caret).toBe("ping @Bob ".length);
});

test("resolveMentions maps @display_name back to member ids", () => {
  const members = [
    member("user_alice", "Alice"),
    member("user_bob", "Bob"),
    member("user_bobby", "Bobby"),
  ];
  // Longest-name-first avoids "Bob" shadowing "Bobby".
  expect(resolveMentions("cc @Bobby please", members)).toEqual(["user_bobby"]);
  expect(resolveMentions("@Alice and @Bob", members).sort()).toEqual([
    "user_alice",
    "user_bob",
  ]);
  // No mention → no ids sent.
  expect(resolveMentions("no mentions here", members)).toEqual([]);
});

test("sendErrorKey calls out an invalid mention, else a generic failure", () => {
  const invalid = new ApiError(400, "INVALID_MENTION", "bad", "trace");
  expect(sendErrorKey(invalid)).toBe("无法提及无效成员");
  const server = new ApiError(500, "INTERNAL_ERROR", "boom", "trace");
  expect(sendErrorKey(server)).toBe("无法发送评论");
  expect(sendErrorKey(new Error("network"))).toBe("无法发送评论");
});
