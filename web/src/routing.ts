export const pages = [
  "overview",
  "tasks",
  "contexts",
  "artifacts",
  "approvals",
  "agents",
  "tools",
  "members",
  "audit",
  "management",
  "operations",
  "help",
] as const;

export type PageID = (typeof pages)[number];
/** Project-scoped route (`/projects/:id/...`); `kind` defaults to "project". */
export type ProjectRoute = {
  kind?: "project";
  projectID: string;
  page: PageID;
  taskID?: string;
  /** Unknown page segment, decode failure, or extra path parts (O4). */
  invalid?: boolean;
};
/** Cross-project "my work" route (`/me/work`), with no project scope (F2). */
export type WorkRoute = {
  kind: "work";
  /** Unknown `/me/...` segment — reuses the invalid-link page pattern. */
  invalid?: boolean;
};
export type Route = ProjectRoute | WorkRoute;

function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function pathOnly(pathname: string): string {
  return pathname.split(/[?#]/, 1)[0] || "/";
}

export function readRoute(pathname: string): Route {
  const parts = pathOnly(pathname).split("/").filter(Boolean);
  if (parts[0] === "me") {
    if (parts[1] === "work" && parts.length === 2) return { kind: "work" };
    return { kind: "work", invalid: true };
  }
  // Project routes omit `kind` (it defaults to "project") so object-equality
  // assertions in tests match the historical shape; only work routes tag `kind`.
  if (parts[0] !== "projects" || !parts[1])
    return { projectID: "", page: "overview" };
  const projectID = segment(parts[1]);
  if (!projectID) return { projectID: "", page: "overview", invalid: true };
  if (!parts[2]) return { projectID, page: "overview" };
  const page = pages.find((candidate) => candidate === parts[2]);
  if (!page) return { projectID, page: "overview", invalid: true };
  if (page === "tasks") {
    if (parts.length === 3) return { projectID, page };
    if (parts.length === 4) {
      const taskID = segment(parts[3]);
      if (!taskID) return { projectID, page, invalid: true };
      return { projectID, page, taskID };
    }
    return { projectID, page, invalid: true };
  }
  if (parts.length > 3) return { projectID, page, invalid: true };
  return { projectID, page };
}

/**
 * Approval deep-link focus id from `location.search` (`?approval=:id`, O-W11).
 * `readRoute` ignores the query, so the approvals view consumes it directly.
 */
export function readApprovalFocus(search: string): string {
  return new URLSearchParams(search).get("approval") || "";
}

export function routePath(route: Route): string {
  if (route.kind === "work") return "/me/work";
  if (!route.projectID) return "/";
  const root = `/projects/${encodeURIComponent(route.projectID)}`;
  return route.taskID && route.page === "tasks"
    ? `${root}/tasks/${encodeURIComponent(route.taskID)}`
    : `${root}/${route.page}`;
}
