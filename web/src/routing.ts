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
export type Route = { projectID: string; page: PageID; taskID?: string };

function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function readRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "projects" || !parts[1])
    return { projectID: "", page: "overview" };
  const projectID = segment(parts[1]);
  const page = pages.find((candidate) => candidate === parts[2]) || "overview";
  const taskID =
    page === "tasks" && parts[3] && parts.length === 4
      ? segment(parts[3])
      : undefined;
  return { projectID, page, taskID };
}

export function routePath(route: Route): string {
  if (!route.projectID) return "/";
  const root = `/projects/${encodeURIComponent(route.projectID)}`;
  return route.taskID && route.page === "tasks"
    ? `${root}/tasks/${encodeURIComponent(route.taskID)}`
    : `${root}/${route.page}`;
}
