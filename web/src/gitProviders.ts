import { normalizeRepositoryUrl } from "./archiveBlockers";

export type GitProvider = "github" | "gitlab";

const gitlabSegment = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function gitlabPath(raw: string): string | undefined {
  const name = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!name || name.length > 512) return undefined;
  const segments = name.split("/");
  if (segments.length < 2) return undefined;
  if (segments.some((s) => s === "." || s === ".." || !gitlabSegment.test(s)))
    return undefined;
  return name;
}

/**
 * Accept either a full HTTPS GitLab URL (gitlab.com or a self-hosted host) or a
 * short group/project path. A short path defaults to the gitlab.com host. The
 * project path may be nested (group/subgroup/project). Returns the canonical
 * "https://host/path" URL, or undefined when the input is not acceptable.
 */
export function normalizeGitLabUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!value.includes("://")) {
    if (/[\s]/.test(value)) return undefined;
    const path = gitlabPath(value);
    return path ? `https://gitlab.com/${path}` : undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return undefined;
    const host = parsed.hostname.toLowerCase();
    if (!host) return undefined;
    const path = gitlabPath(parsed.pathname);
    return path ? `https://${host}/${path}` : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeRepository(
  provider: GitProvider,
  raw: string,
): string | undefined {
  return provider === "gitlab"
    ? normalizeGitLabUrl(raw)
    : normalizeRepositoryUrl(raw);
}
