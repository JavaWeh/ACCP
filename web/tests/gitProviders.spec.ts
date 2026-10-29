// Pure/unit coverage for the F6 GitLab URL normalization. normalizeGitLabUrl
// (full HTTPS URL or short group/project path → canonical https URL, rejecting
// malformed input, O-W18) and normalizeRepository (provider dispatch) are pure
// module-level functions and tested directly, mirroring the audit spec. Full
// DOM behaviour (register form, token no-echo, test-pull) is residual
// managed-server e2e.
import { expect, test } from "@playwright/test";
import { normalizeGitLabUrl, normalizeRepository } from "../src/gitProviders";

test("normalizeGitLabUrl accepts a short group/project path", () => {
  expect(normalizeGitLabUrl("group/project")).toBe(
    "https://gitlab.com/group/project",
  );
  // Nested subgroups and a trailing .git / slashes are normalized away.
  expect(normalizeGitLabUrl("group/sub/project.git")).toBe(
    "https://gitlab.com/group/sub/project",
  );
  expect(normalizeGitLabUrl("  /group/project/  ")).toBe(
    "https://gitlab.com/group/project",
  );
});

test("normalizeGitLabUrl accepts a full HTTPS URL on any host", () => {
  expect(normalizeGitLabUrl("https://gitlab.com/group/project")).toBe(
    "https://gitlab.com/group/project",
  );
  expect(normalizeGitLabUrl("https://gitlab.example.com/group/project")).toBe(
    "https://gitlab.example.com/group/project",
  );
});

test("normalizeGitLabUrl rejects malformed input", () => {
  expect(normalizeGitLabUrl("")).toBeUndefined();
  expect(normalizeGitLabUrl("single")).toBeUndefined();
  expect(normalizeGitLabUrl("group project")).toBeUndefined();
  expect(normalizeGitLabUrl("http://gitlab.com/group/project")).toBeUndefined();
  expect(
    normalizeGitLabUrl("https://user:pw@gitlab.com/group/project"),
  ).toBeUndefined();
  expect(
    normalizeGitLabUrl("https://gitlab.com/group/project?x=1"),
  ).toBeUndefined();
  expect(normalizeGitLabUrl("group/../project")).toBeUndefined();
});

test("normalizeRepository dispatches on provider", () => {
  expect(normalizeRepository("gitlab", "group/project")).toBe(
    "https://gitlab.com/group/project",
  );
  // GitHub delegates to the existing owner/repo normalizer.
  expect(normalizeRepository("github", "owner/repo")).toBe(
    "https://github.com/owner/repo",
  );
});
