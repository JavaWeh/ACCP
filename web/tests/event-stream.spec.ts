import { expect, test } from "@playwright/test";
import { parseFrame, splitFrames } from "../src/app/useEventStream";

test("splitFrames returns complete frames and keeps the trailing partial", () => {
  const { frames, rest } = splitFrames(
    "id: a\nevent: accp.events\ndata: {}\n\nid: b\ndata: {",
  );
  expect(frames).toEqual(["id: a\nevent: accp.events\ndata: {}"]);
  expect(rest).toBe("id: b\ndata: {");
});

test("splitFrames normalizes CRLF delimiters", () => {
  const { frames, rest } = splitFrames("event: x\r\ndata: 1\r\n\r\nleftover");
  expect(frames).toEqual(["event: x\ndata: 1"]);
  expect(rest).toBe("leftover");
});

test("parseFrame reads event, id, and space-trimmed data", () => {
  const frame = parseFrame('id: 42\nevent: accp.events\ndata: {"items":[1]}');
  expect(frame).toEqual({
    event: "accp.events",
    id: "42",
    data: '{"items":[1]}',
  });
});

test("parseFrame joins multi-line data and ignores comments", () => {
  expect(parseFrame(": keep-alive\ndata: line1\ndata: line2")).toEqual({
    event: "message",
    id: "",
    data: "line1\nline2",
  });
});

test("parseFrame recognizes the server-close frame", () => {
  const frame = parseFrame('event: accp.closed\ndata: {"reason":"x"}');
  expect(frame).toEqual({
    event: "accp.closed",
    id: "",
    data: '{"reason":"x"}',
  });
});
