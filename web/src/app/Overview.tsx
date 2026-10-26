import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Card } from "@heroui/react";
import { Button, Badge, Empty } from "../ui";
import type { Workspace } from "./types";

export function Overview({
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
