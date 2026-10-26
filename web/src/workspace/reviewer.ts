import type { Workspace } from "../main";

export const reviewer = (w: Workspace) =>
  w.roles.includes("REVIEWER") || w.roles.includes("ADMIN");
