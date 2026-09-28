import {
  useI18n,
  LocaleProvider,
  LanguageSwitcher,
  LocalizedError,
} from "./i18n";
import { Icon } from "./icons";
import { Avatar, Card, Spinner } from "@heroui/react";
import { createRoot } from "react-dom/client";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  UserManager,
  WebStorageStateStore,
  InMemoryWebStorage,
} from "oidc-client-ts";
import { API } from "./api";
import type { Doc, Membership, Page } from "./api";
import {
  Button,
  Input,
  Select,
  Badge,
  Empty,
  Field,
  Form,
  Message,
  text,
} from "./ui";
import { readRoute, routePath, type PageID, type Route } from "./routing";
import "./style.css";

const Management = lazy(() =>
  import("./management").then((m) => ({ default: m.Management })),
);
const Operations = lazy(() =>
  import("./operations").then((m) => ({ default: m.Operations })),
);
const Help = lazy(() => import("./help").then((m) => ({ default: m.Help })));
const Tasks = lazy(() => import("./tasks").then((m) => ({ default: m.Tasks })));
const TaskDetail = lazy(() =>
  import("./tasks").then((m) => ({ default: m.TaskDetail })),
);
const Contexts = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Contexts })),
);
const Artifacts = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Artifacts })),
);
const Approvals = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Approvals })),
);
const Agents = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Agents })),
);
const Members = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Members })),
);
const Audit = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Audit })),
);
const Tools = lazy(() =>
  import("./workspace").then((m) => ({ default: m.Tools })),
);

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
type Workbench = {
  checked_at?: string;
  mine: number;
  review: number;
  attention: number;
  approvals: number;
  action_tasks: Doc[];
  recent_tasks: Doc[];
};
const emptyWorkbench: Workbench = {
  mine: 0,
  review: 0,
  attention: 0,
  approvals: 0,
  action_tasks: [],
  recent_tasks: [],
};
type AuthConfig = {
  mode: string;
  issuer: string;
  client_id: string;
  public_url: string;
};

function App() {
  const { translate, label, number, time } = useI18n();

  const allNav = [
    { id: "overview", title: translate("工作概览") },
    { id: "tasks", title: translate("任务协作") },
    { id: "contexts", title: translate("共享上下文") },
    { id: "artifacts", title: translate("交付成果") },
    { id: "approvals", title: translate("审批中心") },
    { id: "members", title: translate("项目成员") },
    { id: "agents", title: translate("执行代理") },
    { id: "help", title: translate("使用帮助") },
    { id: "management", title: translate("项目管理") },
    { id: "tools", title: translate("工具网关") },
    { id: "operations", title: translate("系统运行") },
    { id: "audit", title: translate("审计记录") },
  ];

  const [config, setConfig] = useState<AuthConfig>();
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState<unknown>();
  const [route, setRoute] = useState<Route>(() => readRoute(location.pathname));
  const page = route.page;
  const [me, setMe] = useState<Doc>();
  const [projects, setProjects] = useState<Doc[]>([]);
  const [projectID, setProjectID] = useState("");
  const [dataProjectID, setDataProjectID] = useState("");
  const navigate = useCallback((next: Route, replace = false) => {
    const path = routePath(next);
    if (replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    setRoute(next);
  }, []);
  useEffect(() => {
    const onPopState = () => setRoute(readRoute(location.pathname));
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);
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
  useEffect(() => {
    if (!route.projectID || route.projectID === projectID) return;
    if (projects.some((project) => project.id === route.projectID))
      setProjectID(route.projectID);
  }, [route.projectID, projectID, projects]);
  const api = useMemo(
    () =>
      new API(token, () => {
        setToken("");
        setMe(undefined);
        setAuthError(new LocalizedError("登录已过期，请重新登录。"));
      }),
    [token],
  );
  const manager = useMemo(
    () =>
      config?.mode === "oidc"
        ? new UserManager({
            authority: config.issuer,
            client_id: config.client_id,
            redirect_uri: `${config.public_url}/auth/callback`,
            post_logout_redirect_uri: config.public_url,
            response_type: "code",
            scope: "openid profile",
            automaticSilentRenew: false,
            disablePKCE: false,
            stateStore: new WebStorageStateStore({
              store: window.sessionStorage,
            }),
            userStore: new WebStorageStateStore({
              store: new InMemoryWebStorage(),
            }),
          })
        : undefined,
    [config],
  );
  useEffect(() => {
    fetch("/api/v1/auth/config")
      .then((r) => {
        if (!r.ok) throw new LocalizedError("登录服务暂不可用");
        return r.json();
      })
      .then(setConfig)
      .catch(setAuthError);
  }, []);
  useEffect(() => {
    if (!manager) return;
    let active = true;
    (async () => {
      try {
        const user =
          location.pathname === "/auth/callback"
            ? await manager.signinRedirectCallback()
            : await manager.getUser();
        if (active && user && !user.expired && user.access_token) {
          setToken(user.access_token);
          if (location.pathname === "/auth/callback") {
            const returnTo = (user.state as { returnTo?: unknown } | null)
              ?.returnTo;
            const safePath =
              typeof returnTo === "string" &&
              returnTo.startsWith("/") &&
              !returnTo.startsWith("//") &&
              returnTo !== "/auth/callback"
                ? returnTo
                : "/";
            history.replaceState(null, "", safePath);
            setRoute(readRoute(safePath));
          }
        }
        await manager.clearStaleState();
      } catch (e) {
        if (active) setAuthError(e);
      }
    })();
    return () => {
      active = false;
    };
  }, [manager]);
  useEffect(() => {
    if (!manager) return;
    const expired = () => {
      setToken("");
      setMe(undefined);
      setAuthError(new LocalizedError("登录已过期，请重新登录。"));
      void manager.removeUser();
    };
    manager.events.addAccessTokenExpired(expired);
    return () => manager.events.removeAccessTokenExpired(expired);
  }, [manager]);
  async function reloadProjects(id?: string) {
    const list = await api.all("/projects");
    setProjects(list);
    if (id) {
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
          const requested = readRoute(location.pathname).projectID;
          const initial =
            list.find((project) => project.id === requested)?.id ||
            list[0]?.id ||
            "";
          setProjectID(initial);
          if (initial && initial !== requested)
            navigate({ projectID: initial, page: "overview" }, true);
        }
      })
      .catch((e) => {
        if (active) setAuthError(e);
      });
    return () => {
      active = false;
    };
  }, [api, token, navigate]);
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
  async function logout() {
    ++refreshGeneration.current;
    setToken("");
    setMe(undefined);
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
    if (manager) {
      const user = await manager.getUser();
      await manager.removeUser();
      await manager
        .signoutRedirect({ id_token_hint: user?.id_token })
        .catch(setAuthError);
    }
  }
  if (!token || !me)
    return (
      <main className="grid min-h-screen bg-white lg:grid-cols-2">
        <section className="relative hidden min-h-screen flex-col justify-between overflow-hidden bg-slate-950 p-12 text-white lg:flex xl:p-20">
          <div
            className="pointer-events-none absolute -right-36 top-20 size-[600px] rounded-full bg-indigo-600/25 blur-[100px]"
            aria-hidden="true"
          />
          <div className="relative flex items-center gap-3 text-xl font-semibold">
            <img src="/brand/accp-logo-mark.svg" alt="" className="size-12" />{" "}
            ACCP{" "}
            <span className="ml-2 text-xs font-normal text-slate-400">
              {translate("Workspace")}
            </span>
          </div>
          <div className="relative max-w-lg">
            <p className="mb-6 text-xs font-semibold tracking-[0.2em] text-indigo-300">
              {translate("BUILT FOR COLLABORATION")}
            </p>
            <h1 className="text-5xl font-semibold leading-[1.3] tracking-tight xl:text-6xl">
              {translate("让人负责，")}
              <br />
              <span className="text-indigo-300">
                {translate("让协作有据可循。")}
              </span>
            </h1>
            <p className="mt-7 max-w-md text-base leading-8 text-slate-300">
              {translate(
                "把团队、AI 执行代理和交付证据连接起来。每项任务有明确的负责人，每一次交付都可追溯。",
              )}
            </p>
            <div className="mt-12 grid grid-cols-3 gap-3">
              {[
                ["members", translate("人类治理")],
                ["agents", translate("Agent 执行")],
                ["artifacts", translate("成果验收")],
              ].map(([icon, title], i) => (
                <div
                  key={icon}
                  className="rounded-xl border border-white/15 bg-white/5 p-4"
                >
                  <Icon name={icon} className="mb-5 text-indigo-300" />
                  <p className="text-xs text-slate-400">0{i + 1}</p>
                  <p className="mt-1 text-sm font-medium">{title}</p>
                </div>
              ))}
            </div>
          </div>
          <p className="relative text-xs text-slate-400">
            ACCP / AGENT COLLABORATION CONTROL PLANE
          </p>
        </section>
        <Card className="login-card m-auto w-full max-w-lg border-0 bg-transparent p-7 shadow-none sm:p-12">
          <div className="mb-6 flex justify-end">
            <LanguageSwitcher />
          </div>
          <img
            src="/brand/accp-logo-mark.svg"
            alt="ACCP"
            className="mb-7 size-16"
          />
          <p className="mb-3 text-xs font-semibold tracking-widest text-indigo-700">
            {translate("欢迎回来")}
          </p>
          <h2 className="text-3xl font-semibold tracking-tight">
            {translate("进入协作工作空间")}
          </h2>
          <p className="mb-8 mt-3 text-sm text-slate-600">
            {translate("使用你的企业身份访问授权项目。")}
          </p>
          {authError !== undefined && <Message error={authError} />}{" "}
          {!config ? (
            <p>{translate("正在连接登录服务…")}</p>
          ) : config.mode === "development" &&
            location.pathname === "/dev-login" ? (
            <Form
              submit={translate("登录工作空间")}
              action={async (data) => {
                const value = text(data, "token");
                const probe = new API(value, () => {});
                await probe.call("/me");
                setAuthError(undefined);
                const returnTo = new URLSearchParams(location.search).get(
                  "returnTo",
                );
                if (
                  returnTo?.startsWith("/projects/") &&
                  !returnTo.startsWith("//")
                )
                  navigate(readRoute(returnTo), true);
                setToken(value);
              }}
            >
              <div className="notice">
                {translate("本地开发环境 · 使用管理员提供的个人开发凭证。")}
              </div>
              <Field label={translate("个人开发凭证")}>
                <Input
                  name="token"
                  type="password"
                  autoComplete="off"
                  required
                  placeholder={translate("输入个人访问凭证")}
                />
              </Field>
            </Form>
          ) : config.mode === "development" ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
              <p>{translate("此环境使用本地开发认证。")}</p>
              <a
                className="mt-3 inline-block font-medium"
                href={`/dev-login?returnTo=${encodeURIComponent(location.pathname)}`}
              >
                {translate("前往开发登录 →")}
              </a>
            </div>
          ) : (
            <Button
              variant="primary"
              className="w-full"
              onClick={() =>
                manager
                  ?.signinRedirect({ state: { returnTo: location.pathname } })
                  .catch(setAuthError)
              }
            >
              {translate("使用企业账号登录 →")}
            </Button>
          )}
          <small className="mt-8 block border-t border-slate-200 pt-6 text-xs leading-6 text-slate-600">
            {translate("每次执行都有明确的人类责任主体。")}
          </small>
        </Card>
      </main>
    );
  const project = projects.find((p) => p.id === projectID);
  const roles: string[] =
    dataProjectID === projectID
      ? data.members.find((m) => m.id === me.id)?.roles || []
      : [];
  const admin = roles.includes("ADMIN") || project?.roles?.includes("ADMIN");
  const reviewer = roles.includes("REVIEWER") || admin;
  const managementPages = new Set([
    "management",
    "tools",
    "operations",
    "audit",
  ]);
  const managementArea = managementPages.has(page);
  const allowedNav = allNav.filter((item) => {
    if (["management", "operations", "tools"].includes(item.id)) return admin;
    if (item.id === "agents") return admin || roles.includes("MEMBER");
    if (["approvals", "audit"].includes(item.id)) return reviewer;
    return true;
  });
  const nav = allowedNav.filter(
    (item) => managementPages.has(item.id) === managementArea,
  );
  const navigatePage = (next: string) =>
    navigate({ projectID, page: next as PageID });
  const workspace = project
    ? { api, project, me, ...data, roles, refresh }
    : undefined;
  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-60 lg:flex-col lg:border-r lg:border-b-0">
        <a
          href="/"
          aria-label={translate("ACCP 首页")}
          className="block px-5 py-4 lg:px-6 lg:py-6"
        >
          <img
            src="/brand/accp-logo-horizontal.svg"
            alt="ACCP"
            className="h-9 w-auto max-w-full lg:h-12"
          />
        </a>
        <div className="flex gap-2 px-3 pb-3 lg:grid lg:px-4">
          <Button
            data-testid="area-workspace"
            variant={managementArea ? "ghost" : "outline"}
            aria-current={!managementArea ? "page" : undefined}
            className="min-w-0 flex-1"
            onPress={() => navigatePage("overview")}
          >
            {translate("工作台")}
          </Button>
          {(admin || reviewer) && (
            <Button
              data-testid="area-management"
              variant={managementArea ? "outline" : "ghost"}
              aria-current={managementArea ? "page" : undefined}
              className="min-w-0 flex-1"
              onPress={() => navigatePage(admin ? "management" : "audit")}
            >
              {translate("管理中心")}
            </Button>
          )}
        </div>
        <nav
          aria-label={translate("工作空间导航")}
          className="flex snap-x gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-y-auto lg:px-4"
        >
          {nav.map((item) => (
            <div key={item.id} className="contents lg:block">
              <Button
                variant="ghost"
                aria-label={item.title}
                aria-current={page === item.id ? "page" : undefined}
                className={`h-11 shrink-0 snap-start justify-start gap-3 rounded-lg px-3 text-sm lg:w-full ${page === item.id ? "bg-indigo-50 font-semibold text-indigo-700" : "text-slate-600"}`}
                onClick={() => navigatePage(item.id)}
              >
                <Icon
                  name={
                    item.id === "management" || item.id === "operations"
                      ? "members"
                      : item.id
                  }
                />
                <span>{item.title}</span>
                {item.id === "approvals" &&
                  data.approvals.some((a) => a.status === "PENDING") && (
                    <span className="ml-auto rounded-md bg-indigo-100 px-2 text-xs text-indigo-800">
                      {number(
                        data.approvals.filter((a) => a.status === "PENDING")
                          .length,
                      )}
                    </span>
                  )}
              </Button>
            </div>
          ))}
        </nav>
        <div className="mx-4 mt-auto mb-5 hidden rounded-xl border border-slate-200 bg-slate-50 p-4 lg:block">
          <Icon name="approvals" className="mb-3 text-indigo-600" />
          <p className="text-sm font-medium">{translate("私有协作空间")}</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {translate("人类治理 · 全程可追溯")}
          </p>
        </div>
      </aside>
      <div className="flex min-h-screen min-w-0 flex-col lg:ml-60">
        <header className="flex min-h-20 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3 sm:px-8">
          <div className="w-36 min-w-0 sm:w-52">
            <Select
              aria-label={translate("当前项目")}
              value={projectID}
              onChange={(id) => {
                setProjectID(id);
                navigate({ projectID: id, page: "overview" });
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <LanguageSwitcher />
            <Avatar size="sm" color="accent" aria-hidden="true">
              <Avatar.Fallback>
                {String(me.display_name || me.id).slice(0, 1)}
              </Avatar.Fallback>
            </Avatar>
            <div className="hidden text-sm sm:block">
              <p className="font-medium">{me.display_name || me.id}</p>
              <p className="mt-0.5 text-xs text-slate-600">
                {roles.map(label).join(" / ")}
              </p>
            </div>
            <Button variant="ghost" size="sm" onPress={logout}>
              {translate("退出")}
            </Button>
          </div>
        </header>
        <main className="workspace mx-auto w-full max-w-[1600px] min-w-0 flex-1 px-5 py-7 sm:px-8 lg:p-10">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-medium text-slate-600">
                {translate("工作空间")} / {project?.name || translate("项目")}
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">
                {nav.find((n) => n.id === page)?.title}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-xs text-slate-600 sm:block">
                {updated
                  ? translate("更新于 {time}", { time: time(updated) })
                  : translate("正在同步")}
              </span>
              <Button
                variant="outline"
                size="sm"
                onPress={() => refresh().catch(setError)}
              >
                <Icon name="audit" className="size-4" />
                {translate("刷新")}
              </Button>
            </div>
          </div>
          {error !== undefined && <Message error={error} />}{" "}
          <Suspense
            fallback={
              <div
                className="flex items-center justify-center gap-3 py-24 text-slate-600"
                role="status"
              >
                <Spinner />
                {translate("正在读取项目数据…")}
              </div>
            }
          >
            {loaded &&
            project &&
            !allowedNav.some((item) => item.id === page) ? (
              <Empty title={translate("此页面需要更高权限")}>
                {translate("请联系项目管理员确认你的访问权限。")}
              </Empty>
            ) : page === "management" && admin ? (
              <Management
                api={api}
                projects={projects}
                projectID={projectID}
                reload={reloadProjects}
              />
            ) : !projects.length ? (
              <Empty title={translate("尚无可访问项目")}>
                {translate("请联系管理员配置项目成员关系。")}
              </Empty>
            ) : !loaded ? (
              <div
                className="flex items-center justify-center gap-3 py-24 text-slate-600"
                role="status"
              >
                <Spinner />
                {translate("正在读取项目数据…")}
              </div>
            ) : (
              workspace && (
                <>
                  {project?.status === "ARCHIVED" && (
                    <div className="notice">
                      {translate("项目已归档，历史记录只读。")}
                    </div>
                  )}
                  {page === "overview" && (
                    <Overview
                      w={workspace}
                      navigate={navigatePage}
                      openTask={(id) =>
                        navigate({ projectID, page: "tasks", taskID: id })
                      }
                    />
                  )}{" "}
                  {page === "tasks" &&
                    (route.taskID ? (
                      <TaskDetail
                        key={route.taskID}
                        w={workspace}
                        id={route.taskID}
                        close={() => navigate({ projectID, page: "tasks" })}
                      />
                    ) : (
                      <Tasks
                        w={workspace}
                        onOpenTask={(id) =>
                          navigate({ projectID, page: "tasks", taskID: id })
                        }
                      />
                    ))}{" "}
                  {page === "contexts" && <Contexts w={workspace} />}{" "}
                  {page === "artifacts" && <Artifacts w={workspace} />}{" "}
                  {page === "approvals" && reviewer && (
                    <Approvals w={workspace} />
                  )}{" "}
                  {page === "agents" && (admin || roles.includes("MEMBER")) && (
                    <Agents w={workspace} />
                  )}{" "}
                  {page === "members" && <Members w={workspace} />}{" "}
                  {page === "audit" && reviewer && <Audit w={workspace} />}{" "}
                  {page === "tools" && admin && <Tools w={workspace} />}
                  {page === "operations" && admin && (
                    <Operations w={workspace} />
                  )}
                  {page === "help" && <Help />}
                </>
              )
            )}
          </Suspense>
        </main>
        <footer className="px-6 py-6 text-center text-xs text-slate-600">
          {translate("ACCP · 每一次交付，都有上下文与责任记录。")}
        </footer>
      </div>
    </div>
  );
}
function Overview({
  w,
  navigate,
  openTask,
}: {
  w: Workspace;
  navigate: (page: string) => void;
  openTask: (id: string) => void;
}) {
  const { translate, stamp, number } = useI18n();

  const pendingApprovals = w.workbench.approvals;
  const canReview = w.roles.includes("REVIEWER") || w.roles.includes("ADMIN");
  const actionTasks = w.workbench.action_tasks;

  const counts = [
    {
      title: translate("我负责的"),
      value: w.workbench.mine,
      detail: translate("当前项目中由你负责的任务"),
      page: "tasks",
      icon: "tasks",
    },
    {
      title: translate("等待验收"),
      value: w.workbench.review,
      detail: translate("需要 Owner 确认成果"),
      page: "tasks",
      icon: "artifacts",
    },
    {
      title: translate("需要关注"),
      value: w.workbench.attention,
      detail: translate("执行受阻的任务"),
      page: "tasks",
      icon: "agents",
    },
    {
      title: translate("待审批操作"),
      value: pendingApprovals,
      detail: translate("等待独立人类审核"),
      page: "approvals",
      icon: "approvals",
    },
  ].filter((count) => count.page !== "approvals" || canReview);
  const recent = w.workbench.recent_tasks;
  return (
    <div className="page-enter space-y-6">
      {(!w.contexts.length || !recent.length) && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-7">
          <h2 className="text-lg font-semibold">
            {translate("开始使用当前项目")}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {translate("按顺序准备资料并创建任务，团队就可以开始协作。")}
          </p>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {[
              {
                title: translate("确认成员与仓库"),
                detail: translate("由管理员完成项目设置"),
                page: "management",
                enabled: w.roles.includes("ADMIN"),
              },
              {
                title: translate("准备项目资料"),
                detail: translate("发布需求或接口说明"),
                page: "contexts",
                enabled:
                  w.roles.includes("MEMBER") || w.roles.includes("ADMIN"),
              },
              {
                title: translate("创建第一项任务"),
                detail: translate("写清目标和验收条件"),
                page: "tasks",
                enabled:
                  w.roles.includes("MEMBER") || w.roles.includes("ADMIN"),
              },
            ]
              .filter((step) => step.enabled)
              .map((step, index) => (
                <Button
                  key={step.page}
                  variant="ghost"
                  className="h-auto flex-col items-start rounded-xl border border-slate-200 p-4 text-left whitespace-normal"
                  onPress={() => navigate(step.page)}
                >
                  <span className="text-xs font-semibold text-indigo-700">
                    0{index + 1}
                  </span>
                  <strong className="mt-2 text-sm">{step.title}</strong>
                  <span className="mt-1 text-xs text-slate-600">
                    {step.detail}
                  </span>
                </Button>
              ))}
          </div>
        </section>
      )}
      <section className="flex flex-col justify-between gap-6 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-6 sm:flex-row sm:items-center sm:p-7">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-indigo-700">
            {translate("团队协作，一目了然")}
          </p>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {translate("把目标变成可追溯的交付。")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {translate("聚焦当前任务，跟进执行进展，确认每一次交付。")}
          </p>
        </div>
        <Button
          className="shrink-0 self-start sm:self-auto"
          onPress={() => navigate("tasks")}
        >
          <Icon name="plus" />
          {translate("进入任务协作")}
        </Button>
      </section>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 sm:gap-5">
        {counts.map((c) => (
          <Button
            variant="ghost"
            className="h-auto w-full min-w-0 flex-col items-start gap-0 rounded-xl border border-slate-200 bg-white p-5 text-left whitespace-normal shadow-xs hover:border-indigo-300 sm:p-6"
            key={c.title}
            onPress={() => navigate(c.page)}
          >
            <span className="flex w-full items-center justify-between gap-2 text-sm font-medium text-slate-600">
              {c.title}
              <Icon name={c.icon} className="hidden text-slate-400 sm:block" />
            </span>
            <strong className="my-4 text-4xl font-semibold tracking-tight text-slate-900">
              {number(c.value)}
            </strong>
            <span className="text-xs leading-5 text-slate-600">{c.detail}</span>
          </Button>
        ))}
      </div>
      <Card className="min-w-0 gap-0 rounded-xl border border-slate-200 p-0 shadow-xs">
        <Card.Header className="border-b border-slate-100 px-6 py-5">
          <Card.Title>{translate("我的待办")}</Card.Title>
          <Card.Description>
            {translate("优先处理需要你决定或跟进的工作")}
          </Card.Description>
        </Card.Header>
        <Card.Content className="p-3">
          {!actionTasks.length && !pendingApprovals ? (
            <Empty title={translate("当前没有待办")}>
              {translate("新的验收、审批和异常会显示在这里。")}
            </Empty>
          ) : (
            <>
              {actionTasks.map((task) => (
                <Button
                  key={task.id}
                  variant="ghost"
                  className="h-auto w-full justify-between gap-3 rounded-lg p-4 text-left whitespace-normal"
                  onPress={() => openTask(task.id)}
                >
                  <span className="min-w-0">
                    <strong className="block truncate">{task.title}</strong>
                    <span className="text-xs text-slate-600">
                      {task.status === "IN_REVIEW"
                        ? translate("请验收成果")
                        : translate("请查看执行进展")}
                    </span>
                  </span>
                  <Badge value={task.status} />
                </Button>
              ))}
              {pendingApprovals > 0 && (
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-between rounded-lg p-4 text-left"
                  onPress={() => navigate("approvals")}
                >
                  {translate("待审批操作")}
                  <strong>{number(pendingApprovals)}</strong>
                </Button>
              )}
            </>
          )}
        </Card.Content>
      </Card>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,1fr)]">
        <Card className="min-w-0 gap-0 overflow-hidden rounded-xl border border-slate-200 p-0 shadow-xs">
          <Card.Header className="flex-row items-center justify-between border-b border-slate-100 px-6 py-5">
            <div>
              <Card.Title>{translate("近期任务")}</Card.Title>
              <Card.Description className="mt-1">
                {translate("团队正在推进的协作事项")}
              </Card.Description>
            </div>
            <Button variant="ghost" size="sm" onPress={() => navigate("tasks")}>
              {translate("查看全部")}
              <Icon name="arrow" />
            </Button>
          </Card.Header>
          <Card.Content className="p-3">
            {!recent.length ? (
              <Empty title={translate("从第一项任务开始")}>
                {translate("创建目标、指定负责人并选择执行依据。")}
              </Empty>
            ) : (
              recent.map((task) => (
                <Button
                  variant="ghost"
                  key={task.id}
                  className="h-auto w-full min-w-0 justify-start gap-4 rounded-lg p-3 text-left whitespace-normal sm:p-4"
                  onPress={() => openTask(task.id)}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
                    <Icon name="tasks" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {task.title}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-600">
                      {w.members.find((m) => m.id === task.owner_user_id)
                        ?.display_name || task.owner_user_id}
                      <span className="hidden sm:inline">
                        {" "}
                        · {stamp(task.updated_at)}
                      </span>
                    </span>
                  </span>
                  <Badge value={task.status} />
                </Button>
              ))
            )}
          </Card.Content>
          <Card.Footer className="border-t border-slate-100 px-6 py-4 text-xs text-slate-600">
            {translate("每一项任务，都有明确的负责人和验收依据。")}
          </Card.Footer>
        </Card>
        <Card className="min-w-0 gap-0 rounded-xl border border-slate-200 p-0 shadow-xs">
          <Card.Header className="px-6 pt-5 pb-4">
            <Card.Title>{translate("项目资源")}</Card.Title>
            <Card.Description className="mt-1">
              {translate("协作所需的信息与成员")}
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-1 px-3 pb-3">
            {[
              {
                id: "contexts",
                title: translate("共享上下文"),
                detail: translate("版本明确的执行依据"),
                count: w.contexts.length,
              },
              {
                id: "artifacts",
                title: translate("交付成果"),
                detail: translate("可核验的交付证据"),
                count: w.artifacts.length,
              },
              {
                id: "members",
                title: translate("项目成员"),
                detail: translate("项目角色与权限"),
                count: w.members.filter((m) => m.active).length,
              },
            ].map((item) => (
              <Button
                variant="ghost"
                key={item.id}
                className="h-auto w-full min-w-0 justify-start gap-3 rounded-lg p-3 text-left whitespace-normal"
                onPress={() => navigate(item.id)}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
                  <Icon name={item.id} />
                </span>
                <span className="min-w-0 flex-1 break-words">
                  <span className="block text-sm font-medium text-slate-900">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-xs text-slate-600">
                    {item.detail}
                  </span>
                </span>
                <span className="text-lg font-semibold text-slate-700">
                  {number(item.count)}
                </span>
                <Icon name="arrow" className="size-4 text-slate-400" />
              </Button>
            ))}
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
);
