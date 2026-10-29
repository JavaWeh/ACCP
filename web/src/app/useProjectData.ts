import { useCallback, useEffect, useRef, useState } from "react";
import type { API } from "../api";
import type { Doc, Membership, Page } from "../api";
import { readRoute, type Route } from "../routing";
import { emptyWorkbench, type Workbench } from "./types";

export function useProjectData({
  api,
  token,
  me,
  setMe,
  setAuthError,
  navigate,
  route,
}: {
  api: API;
  token: string;
  me: Doc | undefined;
  setMe: (me: Doc | undefined) => void;
  setAuthError: (error: unknown) => void;
  navigate: (next: Route, replace?: boolean) => void;
  route: Route;
}) {
  const [projects, setProjects] = useState<Doc[]>([]);
  const [projectID, setProjectID] = useState("");
  const [dataProjectID, setDataProjectID] = useState("");
  const [data, setData] = useState<{
    members: Membership[];
    tasks: Doc[];
    workbench: Workbench;
    contexts: Doc[];
    artifacts: Doc[];
    approvals: Doc[];
    tools: Doc[];
  }>({
    members: [],
    tasks: [],
    workbench: emptyWorkbench,
    contexts: [],
    artifacts: [],
    approvals: [],
    tools: [],
  });
  const [error, setError] = useState<unknown>();
  const [loaded, setLoaded] = useState(false);
  const [updated, setUpdated] = useState("");
  const [projectUnavailable, setProjectUnavailable] = useState(false);
  useEffect(() => {
    if (route.invalid) return;
    if (!projects.length) return;
    if (!route.projectID) {
      if (projectUnavailable) setProjectUnavailable(false);
      if (!projectID && projects[0]) {
        setProjectID(projects[0].id);
        navigate({ projectID: projects[0].id, page: "overview" }, true);
      }
      return;
    }
    const known = projects.some((project) => project.id === route.projectID);
    setProjectUnavailable(!known);
    if (known && route.projectID !== projectID) setProjectID(route.projectID);
  }, [
    route.projectID,
    route.invalid,
    projectID,
    projects,
    projectUnavailable,
    navigate,
  ]);
  async function reloadProjects(id?: string) {
    const list = await api.all("/projects");
    setProjects(list);
    if (id) {
      setProjectUnavailable(false);
      setProjectID(id);
      navigate({ projectID: id, page: "management" });
    } else {
      await refresh();
    }
  }
  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([api.call("/me"), api.all("/projects")])
      .then(([human, list]) => {
        if (active) {
          setMe(human);
          setProjects(list);
          const requested = readRoute(location.pathname);
          if (requested.invalid) {
            setProjectUnavailable(false);
            const chrome =
              list.find((project) => project.id === requested.projectID)?.id ||
              list[0]?.id ||
              "";
            setProjectID(chrome);
            return;
          }
          if (
            requested.projectID &&
            !list.some((project) => project.id === requested.projectID)
          ) {
            setProjectUnavailable(true);
            setProjectID("");
            setLoaded(true);
            return;
          }
          setProjectUnavailable(false);
          const initial =
            list.find((project) => project.id === requested.projectID)?.id ||
            list[0]?.id ||
            "";
          setProjectID(initial);
          if (initial && initial !== requested.projectID)
            navigate({ projectID: initial, page: "overview" }, true);
        }
      })
      .catch((e) => {
        if (active) setAuthError(e);
      });
    return () => {
      active = false;
    };
  }, [api, token, navigate, setMe, setAuthError]);
  const refreshGeneration = useRef(0);
  const lastTaskCheck = useRef("");
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!projectID || !me) return;
    const prefix = `/projects/${projectID}`;
    const members = await api.all<Membership>(`${prefix}/members`);
    const roles: string[] = members.find((m) => m.id === me.id)?.roles || [];
    const reviewer = roles.includes("REVIEWER") || roles.includes("ADMIN");
    const [taskPage, workbench, contexts, artifacts, approvals, tools] =
      await Promise.all([
        api.call<Page>(`${prefix}/tasks?limit=50`),
        api.call<Workbench>(`${prefix}/workbench`),
        api.all(`${prefix}/contexts`),
        api.all(`${prefix}/artifacts`),
        reviewer ? api.all(`${prefix}/approvals`) : Promise.resolve([]),
        api.all(`${prefix}/tools`),
      ]);
    if (generation !== refreshGeneration.current) return;
    setData({
      members,
      tasks: taskPage.items,
      workbench,
      contexts,
      artifacts,
      approvals,
      tools,
    });
    lastTaskCheck.current = workbench.checked_at || new Date().toISOString();
    setDataProjectID(projectID);
    setError(undefined);
    setLoaded(true);
    setUpdated(new Date().toISOString());
  }, [projectID, me, api]);
  const refreshChanges = useCallback(async () => {
    if (!projectID || !me || !lastTaskCheck.current) return;
    const generation = ++refreshGeneration.current;
    const since = new Date(
      Date.parse(lastTaskCheck.current) - 1000,
    ).toISOString();
    const prefix = `/projects/${projectID}`;
    const [changes, workbench] = await Promise.all([
      api.all(`${prefix}/tasks?updated_after=${encodeURIComponent(since)}`),
      api.call<Workbench>(`${prefix}/workbench`),
    ]);
    if (generation !== refreshGeneration.current) return;
    setData((current) => {
      if (!changes.length) return { ...current, workbench };
      const tasks = new Map(current.tasks.map((task) => [task.id, task]));
      changes.forEach((task) => tasks.set(task.id, task));
      return {
        ...current,
        workbench,
        tasks: [...tasks.values()]
          .sort((a, b) =>
            String(b.updated_at).localeCompare(String(a.updated_at)),
          )
          .slice(0, 50),
      };
    });
    lastTaskCheck.current = workbench.checked_at || new Date().toISOString();
    setUpdated(lastTaskCheck.current);
  }, [projectID, me, api]);
  useEffect(() => {
    setLoaded(false);
    lastTaskCheck.current = "";
    refresh().catch(setError);
    const timer = setInterval(() => refreshChanges().catch(setError), 10000);
    return () => {
      ++refreshGeneration.current;
      clearInterval(timer);
    };
  }, [refresh, refreshChanges]);

  function resetProjectData() {
    ++refreshGeneration.current;
    setLoaded(false);
    setData({
      members: [],
      tasks: [],
      workbench: emptyWorkbench,
      contexts: [],
      artifacts: [],
      approvals: [],
      tools: [],
    });
  }

  return {
    projects,
    projectID,
    setProjectID,
    dataProjectID,
    data,
    error,
    setError,
    loaded,
    updated,
    projectUnavailable,
    reloadProjects,
    refresh,
    refreshChanges,
    resetProjectData,
  };
}
