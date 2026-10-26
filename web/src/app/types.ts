import type { API } from "../api";
import type { Doc, Membership } from "../api";

export type Workspace = {
  api: API;
  project: Doc;
  me: Doc;
  members: Membership[];
  tasks: Doc[];
  workbench: Workbench;
  contexts: Doc[];
  artifacts: Doc[];
  approvals: Doc[];
  tools: Doc[];
  roles: string[];
  refresh: () => Promise<void>;
};
export type Workbench = {
  checked_at?: string;
  mine: number;
  review: number;
  attention: number;
  approvals: number;
  action_tasks: Doc[];
  recent_tasks: Doc[];
};
export const emptyWorkbench: Workbench = {
  mine: 0,
  review: 0,
  attention: 0,
  approvals: 0,
  action_tasks: [],
  recent_tasks: [],
};
export type AuthConfig = {
  mode: string;
  issuer: string;
  client_id: string;
  public_url: string;
};
