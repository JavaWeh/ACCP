import { useI18n, LanguageSwitcher } from "../i18n";
import { Icon } from "../icons";
import { Alert, Avatar, Chip, Spinner } from "@heroui/react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button, Select, Empty, Message } from "../ui";
import { readRoute, routePath, type PageID, type Route } from "../routing";
import {
  Management,
  Operations,
  Help,
  Tasks,
  TaskDetail,
  Contexts,
  Artifacts,
  Approvals,
  Agents,
  Members,
  Audit,
  Tools,
  MyWork,
} from "./lazyPages";
import { CopyLink } from "../CopyLink";
import { buildReturnTo, sanitizeReturnTo } from "../returnTo";
import { ConnectionStatus } from "./ConnectionStatus";
import { NotificationBell } from "./NotificationBell";
import { useEventStream, type ConnectionState } from "./useEventStream";
import { LoginScreen } from "./LoginScreen";
import { ForbiddenPage, InvalidLinkPage, NotFoundPage } from "./LinkStatus";
import { Overview } from "./Overview";
import { useAuthSession } from "./useAuthSession";
import { useProjectData } from "./useProjectData";
import { RestoreProjectDialog } from "../ProjectsPanel";

export function App() {
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

  const [route, setRoute] = useState<Route>(() => readRoute(location.pathname));
  const workView = route.kind === "work";
  const projectRoute = route.kind === "work" ? undefined : route;
  const page: PageID = projectRoute?.page ?? "overview";
  const taskID = projectRoute?.taskID;
  const navigate = useCallback((next: Route, replace = false) => {
    const path = routePath(next);
    if (replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    setRoute(next);
  }, []);
  const restoreReturnTo = useCallback((raw: unknown) => {
    const safePath = sanitizeReturnTo(raw);
    history.replaceState(null, "", safePath);
    setRoute(readRoute(location.pathname));
  }, []);
  const goHref = useCallback((href: string) => {
    history.pushState(null, "", href);
    setRoute(readRoute(location.pathname));
  }, []);
  useEffect(() => {
    const onPopState = () => setRoute(readRoute(location.pathname));
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  const {
    config,
    token,
    setToken,
    authError,
    setAuthError,
    me,
    setMe,
    api,
    manager,
  } = useAuthSession({ setRoute });

  const {
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
  } = useProjectData({
    api,
    token,
    me,
    setMe,
    setAuthError,
    navigate,
    route,
  });

  const [connection, setConnection] = useState<ConnectionState>("polling");
  useEventStream({
    api,
    projectID,
    enabled: !!(token && me),
    onEvents: refreshChanges,
    onStatus: setConnection,
  });

  const [restoringProject, setRestoringProject] = useState(false);

  async function logout() {
    resetProjectData();
    setToken("");
    setMe(undefined);
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
      <LoginScreen
        config={config}
        authError={authError}
        manager={manager}
        restoreReturnTo={restoreReturnTo}
        setToken={setToken}
        setAuthError={setAuthError}
      />
    );
  const project = projects.find((p) => p.id === projectID);
  const roles: string[] =
    dataProjectID === projectID
      ? data.members.find((m) => m.id === me.id)?.roles || []
      : [];
  const admin = roles.includes("ADMIN") || project?.roles?.includes("ADMIN");
  const isOrgAdmin = me?.is_org_admin === true;
  const reviewer = roles.includes("REVIEWER") || admin;
  const managementPages = new Set([
    "management",
    "tools",
    "operations",
    "audit",
  ]);
  const managementArea = managementPages.has(page);
  const allowedNav = allNav.filter((item) => {
    if (item.id === "management") return admin || isOrgAdmin;
    if (["operations", "tools"].includes(item.id)) return admin;
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
        <div className="px-3 pb-3 lg:px-4">
          <Button
            data-testid="nav-mywork"
            variant="ghost"
            aria-label={translate("我的工作")}
            aria-current={workView ? "page" : undefined}
            className={`h-11 w-full justify-start gap-3 rounded-lg px-3 text-sm ${workView ? "bg-indigo-50 font-semibold text-indigo-700" : "text-slate-600"}`}
            onPress={() => navigate({ kind: "work" })}
          >
            <Icon name="mywork" />
            <span>{translate("我的工作")}</span>
          </Button>
        </div>
        <div className="flex gap-2 px-3 pb-3 lg:grid lg:px-4">
          <Button
            data-testid="area-workspace"
            variant={managementArea ? "ghost" : "outline"}
            aria-current={!managementArea && !workView ? "page" : undefined}
            className="min-w-0 flex-1"
            onPress={() => navigatePage("overview")}
          >
            {translate("工作台")}
          </Button>
          {(admin || reviewer || isOrgAdmin) && (
            <Button
              data-testid="area-management"
              variant={managementArea ? "outline" : "ghost"}
              aria-current={managementArea && !workView ? "page" : undefined}
              className="min-w-0 flex-1"
              onPress={() =>
                navigatePage(admin || isOrgAdmin ? "management" : "audit")
              }
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
                aria-current={
                  !workView && page === item.id ? "page" : undefined
                }
                className={`h-11 shrink-0 snap-start justify-start gap-3 rounded-lg px-3 text-sm lg:w-full ${!workView && page === item.id ? "bg-indigo-50 font-semibold text-indigo-700" : "text-slate-600"}`}
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
                  {p.status === "ARCHIVED"
                    ? `${p.name} (${translate("已归档")})`
                    : p.name}
                </option>
              ))}
            </Select>
          </div>
          <ConnectionStatus
            status={connection}
            lastUpdated={updated}
            onReauthenticate={() =>
              manager
                ?.signinRedirect({ state: { returnTo: buildReturnTo() } })
                .catch(setAuthError)
            }
          />
          <NotificationBell api={api} onOpen={goHref} />
          <div className="flex shrink-0 items-center gap-3">
            <LanguageSwitcher />
            <Avatar size="sm" color="accent" aria-hidden="true">
              <Avatar.Fallback>
                {String(me.display_name || me.id).slice(0, 1)}
              </Avatar.Fallback>
            </Avatar>
            <div className="hidden text-sm sm:block">
              <p className="font-medium">{me.display_name || me.id}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {isOrgAdmin && (
                  <Chip size="sm" variant="soft" color="accent">
                    {translate("组织管理员")}
                  </Chip>
                )}
                {admin && (
                  <Chip size="sm" variant="soft">
                    {translate("项目管理员")}
                  </Chip>
                )}
              </div>
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
          {workView ? (
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
              {route.invalid ? (
                <InvalidLinkPage projectID="" onBack={goHref} />
              ) : (
                <MyWork api={api} onOpen={goHref} />
              )}
            </Suspense>
          ) : (
            <>
              <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
                    <span>
                      {translate("工作空间")} /{" "}
                      {project?.name || translate("项目")}
                    </span>
                    {project?.status === "ARCHIVED" && (
                      <Chip color="warning" size="sm" variant="soft">
                        {translate("已归档")}
                      </Chip>
                    )}
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
                  <CopyLink />
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
                {route.invalid ? (
                  <InvalidLinkPage
                    projectID={projectRoute?.projectID ?? ""}
                    onBack={goHref}
                  />
                ) : projectUnavailable ? (
                  <NotFoundPage
                    backHref="/"
                    backLabel={translate("返回首页")}
                    onBack={goHref}
                  />
                ) : loaded &&
                  project &&
                  !allowedNav.some((item) => item.id === page) ? (
                  <ForbiddenPage />
                ) : page === "management" && (admin || isOrgAdmin) ? (
                  <Management
                    api={api}
                    me={me}
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
                        <div className="mb-6 flex flex-wrap items-start gap-3">
                          <Alert
                            status="warning"
                            className="min-w-0 flex-1"
                            role="status"
                          >
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Title>
                                {translate("项目已归档，只读")}
                              </Alert.Title>
                              <Alert.Description>
                                {translate("项目已归档，历史记录只读。")}
                              </Alert.Description>
                            </Alert.Content>
                          </Alert>
                          {admin && (
                            <Button
                              className="shrink-0"
                              size="sm"
                              onPress={() => setRestoringProject(true)}
                            >
                              {translate("恢复项目")}
                            </Button>
                          )}
                        </div>
                      )}
                      {restoringProject && project && api && (
                        <RestoreProjectDialog
                          api={api}
                          project={project}
                          close={() => setRestoringProject(false)}
                          onDone={async () => {
                            setRestoringProject(false);
                            await reloadProjects();
                          }}
                        />
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
                        (taskID ? (
                          <TaskDetail
                            key={taskID}
                            w={workspace}
                            id={taskID}
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
                      {page === "agents" &&
                        (admin || roles.includes("MEMBER")) && (
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
            </>
          )}
        </main>
        <footer className="px-6 py-6 text-center text-xs text-slate-600">
          {translate("ACCP · 每一次交付，都有上下文与责任记录。")}
        </footer>
      </div>
    </div>
  );
}
