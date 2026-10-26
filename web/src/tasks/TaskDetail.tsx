import { useI18n } from "../i18n";
import { Tabs } from "@heroui/react";
import { useEffect, useState } from "react";
import { ApiError, type Doc, type Page } from "../api";
import { short } from "../api";
import type { Workspace } from "../main";
import { CopyLink } from "../CopyLink";
import { ForbiddenPage, NotFoundPage } from "../app/LinkStatus";
import { Button, Badge, Message } from "../ui";
import { TaskOverviewPanel } from "./TaskOverviewPanel";
import { TaskEvidencePanel } from "./TaskEvidencePanel";
import { TaskHistoryPanel } from "./TaskHistoryPanel";
import { routePath } from "../routing";

export function TaskDetail({
  w,
  id,
  close,
}: {
  w: Workspace;
  id: string;
  close: () => void;
}) {
  const { translate } = useI18n();

  const [task, setTask] = useState<Doc>();
  const [runs, setRuns] = useState<Doc[]>([]);
  const [artifacts, setArtifacts] = useState<Doc[]>([]);
  const [reports, setReports] = useState<Doc[]>([]);
  const [reviews, setReviews] = useState<Doc[]>([]);
  const [dependencies, setDependencies] = useState<Doc[]>([]);
  const [dependencySearch, setDependencySearch] = useState("");
  const [dependencyCandidates, setDependencyCandidates] = useState<Doc[]>([]);
  const [editVersions, setEditVersions] = useState<Doc[]>([]);
  const [editRepos, setEditRepos] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  const [tab, setTab] = useState("overview");
  const [reviewDecision, setReviewDecision] = useState("ACCEPT");
  async function load() {
    const [t, r, rev, dep] = await Promise.all([
      w.api.call(`/tasks/${id}`),
      w.api.all(`/tasks/${id}/runs`),
      w.api.all(`/tasks/${id}/reviews`),
      w.api.all(`/tasks/${id}/dependencies`),
    ]);
    setTask(t);
    r.sort((a, b) => b.attempt - a.attempt);
    setRuns(r);
    setReviews(rev);
    setDependencies(dep);
    if (r.length) {
      const [a, p] = await Promise.all([
        w.api.all(`/task-runs/${r[0].id}/artifacts`),
        w.api.all(`/task-runs/${r[0].id}/reports`),
      ]);
      setArtifacts(a);
      setReports(p);
    } else {
      setArtifacts([]);
      setReports([]);
    }
  }
  useEffect(() => {
    load().catch(setError);
  }, [id, w.api]);
  async function refreshed() {
    await load();
    await w.refresh();
  }
  const run = runs[0];
  const canChange =
    task?.owner_user_id === w.me.id || w.roles.includes("ADMIN");
  useEffect(() => {
    if (
      !task ||
      !canChange ||
      task.archived ||
      !["DRAFT", "READY", "BLOCKED"].includes(task.status)
    )
      return;
    Promise.all([
      Promise.all(
        w.contexts.map(async (context) =>
          w.api.all(`/contexts/${context.id}/versions`),
        ),
      ),
      w.api.all(`/projects/${w.project.id}/repositories`),
    ])
      .then(([versions, repositories]) => {
        setEditVersions(
          versions.flat().filter((version) => version.status === "PUBLISHED"),
        );
        setEditRepos(repositories);
      })
      .catch(setError);
  }, [
    task?.id,
    task?.status,
    task?.archived,
    canChange,
    w.api,
    w.contexts,
    w.project.id,
  ]);
  useEffect(() => {
    if (!canChange || !task) return;
    let live = true;
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ limit: "25" });
        if (dependencySearch.trim()) params.set("q", dependencySearch.trim());
        w.api
          .call<Page>(`/projects/${w.project.id}/tasks?${params}`)
          .then((page) => {
            if (live)
              setDependencyCandidates(
                page.items.filter((candidate) => candidate.id !== id),
              );
          })
          .catch((cause) => {
            if (live) setError(cause);
          });
      },
      dependencySearch ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [w.api, w.project.id, id, canChange, task?.id, dependencySearch]);
  if (error instanceof ApiError && error.status === 404) {
    const tasksHref = routePath({ projectID: w.project.id, page: "tasks" });
    return (
      <NotFoundPage
        backHref={tasksHref}
        backLabel={translate("返回任务列表")}
        onBack={() => close()}
      />
    );
  }
  if (error instanceof ApiError && error.status === 403) {
    return <ForbiddenPage />;
  }
  return (
    <section
      className="task-detail page-enter space-y-5"
      aria-label={translate("任务详情")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onPress={close}>
          ← {translate("任务协作")}
        </Button>
        <div className="flex items-center gap-3">
          <CopyLink
            ariaLabel={translate("复制任务链接：{title}", {
              title: String(task?.title || translate("任务详情")),
            })}
          />
          <code className="text-slate-500">{short(id)}</code>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-8">
        <h2 className="mb-4 text-2xl font-semibold">
          {task?.title || translate("任务详情")}
        </h2>
        {error !== undefined && <Message error={error} />}{" "}
        {!task ? (
          error === undefined ? (
            <p>{translate("正在读取任务…")}</p>
          ) : (
            <Message error={error} />
          )
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <Badge value={task.status} />
              {task.archived && <span>{translate("已归档")}</span>}
              <span>
                {translate("负责人：")}
                {w.members.find((m) => m.id === task.owner_user_id)
                  ?.display_name || task.owner_user_id}
              </span>
              <span>
                {translate("版本 {version}", { version: task.version })}
              </span>
            </div>
            <p className="mb-5 text-sm leading-7 text-slate-600">
              {task.objective}
            </p>
            <Tabs
              selectedKey={tab}
              onSelectionChange={(key) => setTab(String(key))}
            >
              <Tabs.List aria-label={translate("任务详情")}>
                {[
                  { id: "overview", name: translate("任务与执行") },
                  { id: "evidence", name: translate("成果与验收") },
                  { id: "history", name: translate("报告与记录") },
                ].map((t) => (
                  <Tabs.Tab key={t.id} id={t.id}>
                    {t.name}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              <TaskOverviewPanel
                w={w}
                id={id}
                task={task}
                runs={runs}
                dependencies={dependencies}
                canChange={canChange}
                editRepos={editRepos}
                editVersions={editVersions}
                dependencySearch={dependencySearch}
                setDependencySearch={setDependencySearch}
                dependencyCandidates={dependencyCandidates}
                refreshed={refreshed}
              />
              <TaskEvidencePanel
                w={w}
                id={id}
                task={task}
                run={run}
                artifacts={artifacts}
                reviewDecision={reviewDecision}
                setReviewDecision={setReviewDecision}
                refreshed={refreshed}
              />
              <TaskHistoryPanel
                task={task}
                runs={runs}
                reports={reports}
                reviews={reviews}
              />
            </Tabs>
          </>
        )}
      </div>
    </section>
  );
}
