import { useI18n } from "../i18n";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useEffect, useState } from "react";
import type { Page } from "../api";
import type { Workspace } from "../main";
import { Button, Input, Select, Badge, Empty, Message } from "../ui";
import { columns } from "./constants";
import { CreateTask } from "./CreateTask";

export function Tasks({
  w,
  onOpenTask,
}: {
  w: Workspace;
  onOpenTask: (id: string) => void;
}) {
  const { translate, label } = useI18n();

  const [creating, setCreating] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState("");
  const [previous, setPrevious] = useState<string[]>([]);
  const [result, setResult] = useState<Page>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ limit: "25" });
        if (search.trim()) params.set("q", search.trim());
        if (filter === "mine") params.set("owner", w.me.id);
        if (status === "archived") params.set("archived", "true");
        else if (status !== "all") params.set("status", status);
        if (cursor) params.set("cursor", cursor);
        w.api
          .call<Page>(`/projects/${w.project.id}/tasks?${params}`)
          .then((page) => {
            if (!live) return;
            setResult(page);
            setError(undefined);
          })
          .catch((cause) => {
            if (live) setError(cause);
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    w.api,
    w.project.id,
    w.me.id,
    w.tasks,
    search,
    filter,
    status,
    cursor,
    listRevision,
  ]);
  const resetPage = () => {
    setCursor("");
    setPrevious([]);
  };
  const tasks = result.items;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <ToggleButtonGroup
          aria-label={translate("筛选任务")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys) => {
            setFilter(String([...keys][0]));
            resetPage();
          }}
        >
          <ToggleButton id="all">{translate("全部任务")}</ToggleButton>
          <ToggleButton id="mine">{translate("我负责的")}</ToggleButton>
        </ToggleButtonGroup>
        <Input
          className="w-full sm:ml-auto sm:max-w-72"
          aria-label={translate("搜索任务")}
          placeholder={translate("搜索任务…")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            resetPage();
          }}
        />
        <Select
          aria-label={translate("任务状态")}
          value={status}
          onChange={(next) => {
            setStatus(next);
            resetPage();
          }}
        >
          <option value="all">{translate("全部状态")}</option>
          <option value="archived">{translate("已归档")}</option>
          {columns.map((item) => (
            <option key={item} value={item}>
              {label(item)}
            </option>
          ))}
        </Select>
        {(w.roles.includes("MEMBER") || w.roles.includes("ADMIN")) && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            {translate("＋ 创建任务")}
          </Button>
        )}
      </div>
      {error !== undefined && <Message error={error} />}
      {loading ? (
        <Empty title={translate("正在读取任务…")} />
      ) : !tasks.length ? (
        <Empty
          title={
            search || filter !== "all" || status !== "all"
              ? translate("暂无任务")
              : translate("还没有任务")
          }
        >
          {translate(
            "先明确目标、Owner、验收条件与上下文，再分配 Agent 执行。",
          )}
        </Empty>
      ) : (
        <div className="grid gap-3">
          {tasks.map((task) => (
            <Button
              variant="ghost"
              key={task.id}
              onPress={() => onOpenTask(task.id)}
              className="h-auto w-full min-w-0 justify-start gap-5 rounded-xl border border-slate-200 bg-white p-5 text-left whitespace-normal shadow-xs hover:border-indigo-300"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-700">
                <span className={`column-dot dot-${task.status}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-semibold text-slate-900">
                  {task.title}
                </span>
                <span className="mt-1 block line-clamp-2 text-sm text-slate-600">
                  {task.objective}
                </span>
                <span className="mt-2 block text-xs text-slate-500">
                  {w.members.find((m) => m.id === task.owner_user_id)
                    ?.display_name || task.owner_user_id}{" "}
                  ·{" "}
                  {translate("{count} 项依据", {
                    count: task.context_version_ids.length,
                  })}{" "}
                  ·{" "}
                  {translate("{count} 项验收", {
                    count: task.acceptance_criteria.length,
                  })}
                </span>
              </span>
              <Badge value={task.status} />
            </Button>
          ))}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="outline"
          isDisabled={!previous.length}
          onPress={() => {
            setCursor(previous.at(-1) || "");
            setPrevious(previous.slice(0, -1));
          }}
        >
          {translate("上一页")}
        </Button>
        <Button
          variant="outline"
          isDisabled={!result.next_cursor}
          onPress={() => {
            setPrevious([...previous, cursor]);
            setCursor(result.next_cursor || "");
          }}
        >
          {translate("下一页")}
        </Button>
      </div>
      {creating && (
        <CreateTask
          w={w}
          close={() => setCreating(false)}
          checkList={() => {
            setCreating(false);
            setSearch("");
            setFilter("all");
            setStatus("all");
            resetPage();
            setListRevision((revision) => revision + 1);
          }}
        />
      )}{" "}
    </>
  );
}
