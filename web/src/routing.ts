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
export type Route = {
  projectID: string;
  page: PageID;
  taskID?: string;
  /** Unknown page segment, decode failure, or extra path parts (O4). */
  invalid?: boolean;
};

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

export function routePath(route: Route): string {
  if (!route.projectID) return "/";
  const root = `/projects/${encodeURIComponent(route.projectID)}`;
  return route.taskID && route.page === "tasks"
    ? `${root}/tasks/${encodeURIComponent(route.taskID)}`
    : `${root}/${route.page}`;
}
