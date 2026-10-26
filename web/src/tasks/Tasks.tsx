import { useI18n } from "../i18n";
import {
  Alert,
  ProgressBar,
  Spinner,
  Table,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ApiError, type Doc, type Page } from "../api";
import type { Workspace } from "../main";
import { Button, Input, Select, Badge, Empty, Message } from "../ui";
import { columns } from "./constants";
import { CreateTask } from "./CreateTask";
import { readRoute } from "../routing";
import {
  DEFAULT_TASK_LIST_QUERY,
  buildTaskListRequestParams,
  defaultOrderForSort,
  hasActiveFilters,
  parseTaskListSearch,
  taskListSearchEquals,
  writeTaskListUrl,
  type SortField,
  type SortOrder,
  type TaskListQuery,
} from "./taskListSearchParams";

type ListIntent = {
  id: number;
  mode: "first" | "append";
  cursor: string;
};

function readQueryFromLocation(): {
  query: TaskListQuery;
  normalized: boolean;
} {
  return parseTaskListSearch(location.search);
}

export function Tasks({
  w,
  onOpenTask,
}: {
  w: Workspace;
  onOpenTask: (id: string) => void;
}) {
  const { translate, label, stamp } = useI18n();

  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState<TaskListQuery>(() => {
    const { query: parsed, normalized } = readQueryFromLocation();
    if (normalized) writeTaskListUrl(parsed, "replace");
    return parsed;
  });
  const [searchInput, setSearchInput] = useState(query.q);
  const [items, setItems] = useState<Doc[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [intent, setIntent] = useState<ListIntent>({
    id: 0,
    mode: "first",
    cursor: "",
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [firstError, setFirstError] = useState<unknown>();
  const [appendError, setAppendError] = useState(false);
  const [cursorWarning, setCursorWarning] = useState(false);
  const [announce, setAnnounce] = useState("");
  const focusTitleId = useRef<string | null>(null);
  const requestGen = useRef(0);
  const invalidCursorRetried = useRef(false);
  const queryRef = useRef(query);
  const itemsRef = useRef(items);
  const translateRef = useRef(translate);
  queryRef.current = query;
  itemsRef.current = items;
  translateRef.current = translate;

  const startFirst = useCallback((opts?: { refresh?: boolean }) => {
    setAppendError(false);
    setRefreshing(Boolean(opts?.refresh && itemsRef.current.length > 0));
    setIntent((prev) => ({
      id: prev.id + 1,
      mode: "first",
      cursor: "",
    }));
  }, []);

  const applyQuery = useCallback(
    (next: TaskListQuery, history: "push" | "replace" | "none") => {
      setQuery(next);
      setSearchInput(next.q);
      if (history !== "none") writeTaskListUrl(next, history);
      startFirst({ refresh: itemsRef.current.length > 0 });
    },
    [startFirst],
  );

  const patchQuery = useCallback(
    (patch: Partial<TaskListQuery>, history: "push" | "replace" = "push") => {
      applyQuery({ ...queryRef.current, ...patch }, history);
    },
    [applyQuery],
  );

  useEffect(() => {
    const onPopState = () => {
      const route = readRoute(location.pathname);
      // Do not rewrite URL on invalid/other pages (US-12 O4 keeps the address).
      if (route.invalid || route.page !== "tasks" || route.taskID) return;
      const { query: parsed, normalized } = readQueryFromLocation();
      if (normalized) writeTaskListUrl(parsed, "replace");
      if (!taskListSearchEquals(parsed, queryRef.current)) {
        applyQuery(parsed, "none");
      }
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, [applyQuery]);

  // Workspace task cache / project change → reload first batch (skip mount).
  const tasksEpoch = w.tasks;
  const skipTasksEpoch = useRef(true);
  useEffect(() => {
    if (skipTasksEpoch.current) {
      skipTasksEpoch.current = false;
      return;
    }
    startFirst({ refresh: itemsRef.current.length > 0 });
  }, [tasksEpoch, w.project.id, startFirst]);

  useEffect(() => {
    const gen = ++requestGen.current;
    const isAppend = intent.mode === "append";
    if (!isAppend) invalidCursorRetried.current = false;
    setLoading(true);
    if (!isAppend) {
      setFirstError(undefined);
      setAppendError(false);
    }

    const delay = query.q && !isAppend ? 250 : 0;
    const timer = setTimeout(() => {
      const params = buildTaskListRequestParams(
        query,
        w.me.id,
        isAppend ? intent.cursor : "",
      );
      w.api
        .call<Page>(`/projects/${w.project.id}/tasks?${params}`)
        .then((page) => {
          if (gen !== requestGen.current) return;
          const batch = page.items;
          const next = page.next_cursor ?? null;
          setNextCursor(next);
          setFirstError(undefined);
          setAppendError(false);
          setCursorWarning(false);
          setRefreshing(false);
          if (isAppend) {
            const firstNew = batch[0]?.id;
            if (firstNew) focusTitleId.current = firstNew;
            setItems((prev) => [...prev, ...batch]);
            let message = translateRef.current("已加载 {count} 条", {
              count: batch.length,
            });
            if (!next) message += ` ${translateRef.current("已全部加载")}`;
            setAnnounce(message);
          } else {
            setItems(batch);
            if (!batch.length) {
              setAnnounce(
                hasActiveFilters(query)
                  ? translateRef.current("没有符合条件的任务")
                  : translateRef.current("没有任务"),
              );
            } else {
              setAnnounce(
                translateRef.current("已加载 {count} 条", {
                  count: batch.length,
                }),
              );
            }
          }
        })
        .catch((cause) => {
          if (gen !== requestGen.current) return;
          setRefreshing(false);
          if (
            cause instanceof ApiError &&
            cause.status === 400 &&
            cause.code === "INVALID_CURSOR"
          ) {
            if (!invalidCursorRetried.current) {
              invalidCursorRetried.current = true;
              setCursorWarning(true);
              setItems([]);
              startFirst();
              return;
            }
          }
          if (isAppend) {
            setAppendError(true);
            setAnnounce(translateRef.current("加载失败"));
          } else {
            setFirstError(cause);
            setItems([]);
            setNextCursor(null);
          }
        })
        .finally(() => {
          if (gen === requestGen.current) setLoading(false);
        });
    }, delay);

    return () => {
      clearTimeout(timer);
      requestGen.current += 1;
    };
  }, [w.api, w.project.id, w.me.id, query, intent, startFirst]);

  useEffect(() => {
    if (!focusTitleId.current || loading) return;
    const id = focusTitleId.current;
    focusTitleId.current = null;
    requestAnimationFrame(() => {
      document.getElementById(`task-title-${id}`)?.focus();
    });
  }, [items, loading]);

  const onSortField = (field: SortField) => {
    patchQuery({
      sort: field,
      order: field === query.sort ? query.order : defaultOrderForSort(field),
    });
  };

  const onSortOrder = (order: SortOrder) => {
    patchQuery({ order });
  };

  const onHeaderSort = (field: SortField) => {
    if (field === query.sort) {
      patchQuery({ order: query.order === "asc" ? "desc" : "asc" });
    } else {
      patchQuery({ sort: field, order: defaultOrderForSort(field) });
    }
  };

  const clearFilters = () => {
    applyQuery(
      {
        ...DEFAULT_TASK_LIST_QUERY,
        sort: query.sort,
        order: query.order,
      },
      "push",
    );
  };

  const mineSelected = query.owner === "me" || query.owner === w.me.id;
  const ownerSelectValue = !query.owner
    ? "all"
    : mineSelected
      ? "me"
      : query.owner;

  const showSkeleton = loading && !items.length && !firstError;
  const showRefreshChrome = refreshing && items.length > 0;
  const appendLoading = loading && intent.mode === "append";
  const canCreate = w.roles.includes("MEMBER") || w.roles.includes("ADMIN");
  const filtersOn = hasActiveFilters(query);

  const ariaSort = (
    field: SortField,
  ): "ascending" | "descending" | undefined =>
    query.sort === field
      ? query.order === "asc"
        ? "ascending"
        : "descending"
      : undefined;

  const taskHref = (id: string) =>
    `/projects/${encodeURIComponent(w.project.id)}/tasks/${encodeURIComponent(id)}`;

  const ownerName = (ownerId: string) =>
    w.members.find((m) => m.id === ownerId)?.display_name || ownerId;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 [&>p]:text-sm [&>p]:text-slate-600">
        <ToggleButtonGroup
          aria-label={translate("筛选任务")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[mineSelected ? "mine" : "all"]}
          onSelectionChange={(keys) => {
            const key = String([...keys][0]);
            patchQuery({ owner: key === "mine" ? "me" : "" });
          }}
        >
          <ToggleButton id="all">{translate("全部任务")}</ToggleButton>
          <ToggleButton id="mine">{translate("我负责的")}</ToggleButton>
        </ToggleButtonGroup>
        <Input
          className="w-full sm:max-w-72"
          aria-label={translate("搜索任务")}
          placeholder={translate("搜索任务…")}
          value={searchInput}
          onChange={(e) => {
            const value = e.target.value;
            setSearchInput(value);
            const trimmed = value.trim();
            if (trimmed === queryRef.current.q) return;
            const next = { ...queryRef.current, q: trimmed };
            setQuery(next);
            writeTaskListUrl(next, "replace");
            startFirst({ refresh: itemsRef.current.length > 0 });
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Escape" && searchInput) {
              e.preventDefault();
              setSearchInput("");
              patchQuery({ q: "" }, "replace");
            }
          }}
        />
        <Select
          aria-label={translate("任务状态")}
          value={query.status || "all"}
          onChange={(next) => {
            patchQuery({ status: next === "all" ? "" : next });
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
        <Select
          aria-label={translate("负责人")}
          value={ownerSelectValue}
          onChange={(next) => {
            if (next === "all") patchQuery({ owner: "" });
            else if (next === "me") patchQuery({ owner: "me" });
            else patchQuery({ owner: next });
          }}
        >
          <option value="all">{translate("全部负责人")}</option>
          <option value="me">
            {w.me.display_name || translate("我负责的")}
          </option>
          {w.members
            .filter((m) => m.id !== w.me.id)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name || m.id}
              </option>
            ))}
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {filtersOn && (
            <Button variant="ghost" onPress={clearFilters}>
              {translate("清除筛选")}
            </Button>
          )}
          {canCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {translate("＋ 创建任务")}
            </Button>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-600">{translate("排序")}</span>
        <Select
          aria-label={translate("排序字段")}
          value={query.sort}
          onChange={(next) => onSortField(next as SortField)}
        >
          <option value="updated_at">{translate("更新时间")}</option>
          <option value="title">{translate("标题")}</option>
        </Select>
        <ToggleButtonGroup
          aria-label={translate("排序方向")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[query.order]}
          onSelectionChange={(keys) => {
            onSortOrder(String([...keys][0]) as SortOrder);
          }}
        >
          <ToggleButton id="desc">↓ {translate("降序")}</ToggleButton>
          <ToggleButton id="asc">↑ {translate("升序")}</ToggleButton>
        </ToggleButtonGroup>
      </div>

      {cursorWarning && (
        <Alert role="status" status="warning" className="my-4 break-words">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {translate("列表条件已变化，已从头重新加载")}
            </Alert.Title>
          </Alert.Content>
        </Alert>
      )}

      {firstError !== undefined && (
        <div className="my-4">
          <Message error={firstError} />
          <p className="mb-2 text-sm text-slate-600">
            {translate("任务加载失败")}
          </p>
          <Button
            variant="secondary"
            onPress={() => {
              setFirstError(undefined);
              startFirst();
            }}
          >
            {translate("重试")}
          </Button>
        </div>
      )}

      {showRefreshChrome && (
        <ProgressBar
          aria-label={translate("正在更新列表")}
          isIndeterminate
          className="mb-2"
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      )}

      <div
        className={showRefreshChrome ? "opacity-60" : undefined}
        aria-busy={loading || undefined}
      >
        {showSkeleton ? (
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={translate("任务列表")}>
                <Table.Header>
                  <Table.Column isRowHeader>{translate("标题")}</Table.Column>
                  <Table.Column>{translate("任务状态")}</Table.Column>
                  <Table.Column>{translate("负责人")}</Table.Column>
                  <Table.Column>{translate("更新时间")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {Array.from({ length: 5 }, (_, i) => (
                    <Table.Row key={`skel-${i}`} id={`skel-${i}`}>
                      <Table.Cell>
                        <div className="h-4 w-48 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
                      </Table.Cell>
                      <Table.Cell>
                        <div className="h-4 w-16 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
                      </Table.Cell>
                      <Table.Cell>
                        <div className="h-4 w-20 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
                      </Table.Cell>
                      <Table.Cell>
                        <div className="h-4 w-28 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : firstError !== undefined ? null : !items.length && !loading ? (
          <Empty
            title={
              filtersOn
                ? translate("没有符合条件的任务")
                : translate("还没有任务")
            }
          >
            {filtersOn ? (
              <Button variant="ghost" onPress={clearFilters}>
                {translate("清除筛选")}
              </Button>
            ) : canCreate ? (
              <>
                {translate("创建第一个任务，开始协作。")}
                <div className="mt-3">
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    {translate("＋ 创建任务")}
                  </Button>
                </div>
              </>
            ) : (
              translate("创建第一个任务，开始协作。")
            )}
          </Empty>
        ) : items.length ? (
          <Table>
            <Table.ScrollContainer className="scroll-pt-24">
              <Table.Content aria-label={translate("任务列表")}>
                <Table.Header>
                  <Table.Column isRowHeader aria-sort={ariaSort("title")}>
                    <button
                      type="button"
                      className="inline-flex min-h-6 min-w-6 items-center gap-1 rounded text-left font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      aria-label={translate("按标题排序")}
                      onClick={() => onHeaderSort("title")}
                    >
                      {translate("标题")}
                      {query.sort === "title"
                        ? query.order === "asc"
                          ? " ↑"
                          : " ↓"
                        : ""}
                    </button>
                  </Table.Column>
                  <Table.Column>{translate("任务状态")}</Table.Column>
                  <Table.Column>{translate("负责人")}</Table.Column>
                  <Table.Column aria-sort={ariaSort("updated_at")}>
                    <button
                      type="button"
                      className="inline-flex min-h-6 min-w-6 items-center gap-1 rounded text-left font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      aria-label={translate("按更新时间排序")}
                      onClick={() => onHeaderSort("updated_at")}
                    >
                      {translate("更新时间")}
                      {query.sort === "updated_at"
                        ? query.order === "asc"
                          ? " ↑"
                          : " ↓"
                        : ""}
                    </button>
                  </Table.Column>
                </Table.Header>
                <Table.Body>
                  {items.map((task) => (
                    <Table.Row key={task.id} id={task.id}>
                      <Table.Cell>
                        <a
                          id={`task-title-${task.id}`}
                          href={taskHref(task.id)}
                          className="font-semibold text-slate-900 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                          onClick={(e) => {
                            e.preventDefault();
                            onOpenTask(task.id);
                          }}
                        >
                          {task.title}
                        </a>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge value={task.status} />
                      </Table.Cell>
                      <Table.Cell>{ownerName(task.owner_user_id)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        {stamp(task.updated_at)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : null}
      </div>

      {items.length > 0 && (
        <div className="mt-5 flex flex-col items-center gap-2">
          {appendError && (
            <Alert
              role="alert"
              status="danger"
              className="w-full max-w-lg break-words"
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{translate("加载失败")}</Alert.Title>
              </Alert.Content>
            </Alert>
          )}
          {nextCursor || appendError || appendLoading ? (
            <Button
              variant="secondary"
              className="min-w-40 px-4"
              aria-busy={appendLoading || undefined}
              aria-disabled={appendLoading || undefined}
              onPress={() => {
                if (appendLoading) return;
                if (appendError) {
                  if (!nextCursor) {
                    startFirst();
                    return;
                  }
                  setAppendError(false);
                  setIntent((prev) => ({
                    id: prev.id + 1,
                    mode: "append",
                    cursor: nextCursor,
                  }));
                  return;
                }
                if (!nextCursor) return;
                setIntent((prev) => ({
                  id: prev.id + 1,
                  mode: "append",
                  cursor: nextCursor,
                }));
              }}
            >
              {appendLoading ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  {translate("正在加载…")}
                </>
              ) : appendError ? (
                translate("重试加载")
              ) : (
                translate("加载更多")
              )}
            </Button>
          ) : (
            !loading && (
              <p className="text-sm text-slate-500">
                <span aria-hidden="true">✓ </span>
                {translate("已全部加载")}
              </p>
            )
          )}
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>

      {creating && (
        <CreateTask
          w={w}
          close={() => setCreating(false)}
          checkList={() => {
            setCreating(false);
            applyQuery({ ...DEFAULT_TASK_LIST_QUERY }, "replace");
          }}
        />
      )}
    </>
  );
}
