export type ArchiveBlocker = {
  kind: "task" | "run" | "invocation" | string;
  id: string;
};

/** Parse ARCHIVE_BLOCKED Problem.detail produced by projectCommand. */
export function parseArchiveBlockers(detail: string): {
  blockers: ArchiveBlocker[];
  extra: number;
} {
  const showing = detail.match(/\(showing\s+(\d+)\s+of\s+(\d+)\):\s*(.*)$/i);
  const legacy = detail.match(/\(up to 20\):\s*(.*)$/i);
  const listPart = showing?.[3] ?? legacy?.[1] ?? "";
  const total = showing ? Number(showing[2]) : undefined;
  const blockers = listPart
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => {
      const split = token.indexOf(":");
      if (split <= 0) return { kind: "unknown", id: token };
      return {
        kind: token.slice(0, split),
        id: token.slice(split + 1),
      };
    })
    .slice(0, 20);
  const extra =
    total !== undefined && Number.isFinite(total)
      ? Math.max(0, total - blockers.length)
      : 0;
  return { blockers, extra };
}

export function normalizeRepositoryUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  let url = value;
  if (!/^https?:\/\//i.test(url) && /^[^/\s]+\/[^/\s]+$/.test(url)) {
    url = `https://github.com/${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return undefined;
    const parts = parsed.pathname
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    if (parts.some((p) => p === "." || p === "..")) return undefined;
    return `https://github.com/${parts[0]}/${parts[1]}`;
  } catch {
    return undefined;
  }
}
