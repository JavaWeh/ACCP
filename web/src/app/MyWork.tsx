import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "@heroui/react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Button, Empty, Message } from "../ui";
import type { API } from "../api";
import { routePath } from "../routing";

export type WorkTaskItem = {
  project_id: string;
  project_name: string;
  task_id: string;
  title: string;
  status: string;
  waiting_since: string;
};
export type WorkApprovalItem = {
  project_id: string;
  project_name: string;
  approval_id: string;
  invocation_id: string;
  task_id: string | null;
  title: string;
  waiting_since: string;
};

/** Deep-link to a task: a project-scoped tasks route carrying the task id. */
export function taskHref(item: WorkTaskItem): string {
  return routePath({
    kind: "project",
    projectID: item.project_id,
    page: "tasks",
    taskID: item.task_id,
  });
}
/**
 * Deep-link to an approval: the approvals page of its project. Approvals have
 * no per-item route, so the row lands on the project's approval list.
 */
export function approvalHref(item: WorkApprovalItem): string {
  return `/projects/${encodeURIComponent(item.project_id)}/approvals`;
}
export type WorkQueue = {
  groups: {
    review: { items: WorkTaskItem[] };
    approval: { items: WorkApprovalItem[] };
    blocked: { items: WorkTaskItem[] };
  };
  checked_at: string;
};

/**
 * Pure view-state decision for the page (extracted so the partial-failure
 * decision is unit-testable without React). Priority: once a load has
 * succeeded (`data` present) an error is a *partial* failure that keeps the
 * groups on screen; only an error with no prior data (and not mid-retry) is a
 * whole-page failure.
 */
export function myWorkViewState({
  data,
  error,
  loading,
}: {
  data: WorkQueue | undefined;
  error: unknown;
  loading: boolean;
}): "loading" | "full-error" | "empty" | "ready" | "partial-error" {
  if (data) {
    if (error !== undefined) return "partial-error";
    const total =
      data.groups.review.items.length +
      data.groups.approval.items.length +
      data.groups.blocked.items.length;
    return total === 0 ? "empty" : "ready";
  }
  if (error !== undefined && !loading) return "full-error";
  return "loading";
}

/**
 * Cross-project "my work" page (F2 / US-19). A single aggregated endpoint
 * (`GET /me/work`, membership-filtered server-side) feeds three fixed groups:
 * review → approval → blocked.
 *
 * Failure handling (decision D-5, revised): the first load failing with no
 * prior data shows a whole-page retry. But once a load has succeeded, any
 * later refresh/poll/retry failure keeps the last good groups on screen and
 * surfaces a partial-failure warning Alert ("部分项目未能加载" + "重试失败项")
 * instead of wiping the page. A 401 is still handled by the shared OIDC expiry
 * flow (api.onExpired) that swaps in the login screen, so no session-expired
 * UI is duplicated here.
 */
export function MyWork({
  api,
  onOpen,
}: {
  api: API;
  onOpen: (href: string) => void;
}) {
  const { translate, number, relative } = useI18n();
  const [data, setData] = useState<WorkQueue>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  // Mirror of `data` so the memoized refresh (deps [api]) can tell "already
  // loaded once" from "first load" without re-creating itself each render.
  const dataRef = useRef<WorkQueue | undefined>(undefined);

  const refresh = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const queue = await api.call<WorkQueue>("/me/work");
        dataRef.current = queue;
        setData(queue);
        setError(undefined);
      } catch (e) {
        // Once we have prior data, any failure (silent poll, explicit retry, or
        // non-silent refresh) becomes a partial failure that keeps the last
        // good groups and raises the banner. A silent poll with no data yet is
        // ignored — the first load is always non-silent and owns loading/error.
        if (!silent || dataRef.current) setError(e);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);
  // Poll fallback on the console's 10s cadence (D-2): the current project's SSE
  // only covers one project, so the cross-project view relies on this poll.
  useEffect(() => {
    const timer = setInterval(() => void refresh(true), 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  const total = data
    ? data.groups.review.items.length +
      data.groups.approval.items.length +
      data.groups.blocked.items.length
    : 0;
  const state = myWorkViewState({ data, error, loading });

  function Row({
    href,
    project,
    title,
    waiting,
  }: {
    href: string;
    project: string;
    title: string;
    waiting: string;
  }) {
    return (
      <li className="flex flex-col gap-1 border-t border-slate-100 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-sm text-slate-600">{project}</p>
          <a
            href={href}
            aria-label={translate("{title}，项目 {project}", {
              title,
              project,
            })}
            onClick={(event) => {
              event.preventDefault();
              onOpen(href);
            }}
            className="line-clamp-2 font-medium text-indigo-700 underline-offset-2 outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-600"
          >
            {title}
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm text-slate-600">
          <time dateTime={waiting}>{relative(waiting)}</time>
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1 text-indigo-700"
          >
            {translate("打开")}
            <Icon name="arrow" className="size-4" />
          </span>
        </div>
      </li>
    );
  }

  function Group({
    title,
    count,
    children,
  }: {
    title: string;
    count: number;
    children: ReactNode;
  }) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {title}
          <span className="rounded-md bg-slate-100 px-2 text-sm font-normal text-slate-600">
            {number(count)}
          </span>
        </h2>
        {count === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            {translate("本组暂无事项")}
          </p>
        ) : (
          <ul className="mt-2">{children}</ul>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">
          {translate("我的工作")}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {translate("我的工作")}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {translate("汇总你在各项目中待处理的事项。")}
        </p>
      </div>
      {state === "partial-error" && (
        <Alert status="warning" role="status" aria-live="polite">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("部分项目未能加载")}</Alert.Title>
            <div className="mt-3">
              <Button variant="primary" onPress={() => void refresh(false)}>
                {translate("重试失败项")}
              </Button>
            </div>
          </Alert.Content>
        </Alert>
      )}
      {state === "loading" ? (
        <div role="status" aria-busy="true" className="space-y-4">
          {[0, 1, 2].map((group) => (
            <div
              key={group}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="h-5 w-32 rounded bg-slate-200 motion-safe:animate-pulse" />
              <div className="mt-4 space-y-3">
                {[0, 1].map((row) => (
                  <div
                    key={row}
                    className="h-6 w-full rounded bg-slate-100 motion-safe:animate-pulse"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : state === "full-error" ? (
        <div role="alert" className="space-y-3">
          <p className="text-lg font-semibold">
            {translate("无法加载「我的工作」")}
          </p>
          <Message error={error} />
          <Button variant="primary" onPress={() => void refresh(false)}>
            {translate("重试")}
          </Button>
        </div>
      ) : data && total === 0 ? (
        <div className="space-y-4">
          <Empty title={translate("当前没有待办")}>
            {translate("各项目中暂时没有需要你处理的事项。")}
          </Empty>
          <div className="text-center">
            <Button variant="primary" onPress={() => onOpen("/")}>
              {translate("查看项目列表")}
            </Button>
          </div>
        </div>
      ) : data ? (
        <>
          <p className="sr-only" role="status">
            {translate("已加载 {count} 条", { count: total })}
          </p>
          <Group
            title={translate("待评审")}
            count={data.groups.review.items.length}
          >
            {data.groups.review.items.map((item) => (
              <Row
                key={item.task_id}
                href={taskHref(item)}
                project={item.project_name}
                title={item.title}
                waiting={item.waiting_since}
              />
            ))}
          </Group>
          <Group
            title={translate("待审批")}
            count={data.groups.approval.items.length}
          >
            {data.groups.approval.items.map((item) => (
              <Row
                key={item.approval_id}
                href={approvalHref(item)}
                project={item.project_name}
                title={item.title}
                waiting={item.waiting_since}
              />
            ))}
          </Group>
          <Group
            title={translate("阻塞 / 需关注")}
            count={data.groups.blocked.items.length}
          >
            {data.groups.blocked.items.map((item) => (
              <Row
                key={item.task_id}
                href={taskHref(item)}
                project={item.project_name}
                title={item.title}
                waiting={item.waiting_since}
              />
            ))}
          </Group>
        </>
      ) : null}
    </div>
  );
}
