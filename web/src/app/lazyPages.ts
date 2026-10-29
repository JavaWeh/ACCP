import { lazy } from "react";

export const Management = lazy(() =>
  import("../management").then((m) => ({ default: m.Management })),
);
export const Operations = lazy(() =>
  import("../operations").then((m) => ({ default: m.Operations })),
);
export const Help = lazy(() =>
  import("../help").then((m) => ({ default: m.Help })),
);
export const Tasks = lazy(() =>
  import("../tasks").then((m) => ({ default: m.Tasks })),
);
export const TaskDetail = lazy(() =>
  import("../tasks").then((m) => ({ default: m.TaskDetail })),
);
export const Contexts = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Contexts })),
);
export const Artifacts = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Artifacts })),
);
export const Approvals = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Approvals })),
);
export const Agents = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Agents })),
);
export const Members = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Members })),
);
export const Audit = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Audit })),
);
export const Tools = lazy(() =>
  import("../workspace").then((m) => ({ default: m.Tools })),
);
export const MyWork = lazy(() =>
  import("./MyWork").then((m) => ({ default: m.MyWork })),
);
